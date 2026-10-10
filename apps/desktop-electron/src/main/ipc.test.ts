// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_METHODS, bridgeChannels, channelOf } from "../shared/bridge.ts";
import { IpcRegistry, check, type IpcEventLike } from "./ipc.ts";
import { NodeUrlError } from "./node_url.ts";

const trusted: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };
const untrusted: IpcEventLike = { sender: "main", senderFrame: { url: "https://www.youtube-nocookie.com/embed/x" } };
const isTrusted = (e: IpcEventLike) => e === trusted;

function fakeIpcMain() {
  const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown) {
      assert.ok(!handlers.has(channel), `${channel} registered twice`);
      handlers.set(channel, listener);
    },
  };
}

test("every method of the bridge has its channel, and nothing else is listened to", () => {
  const ipc = fakeIpcMain();
  new IpcRegistry(isTrusted).install(ipc);
  assert.deepEqual([...ipc.handlers.keys()].sort(), bridgeChannels().sort());
  assert.equal(ipc.handlers.size, Object.values(BRIDGE_METHODS).flat().length);
  assert.equal(channelOf("shell", "setNode"), "tavrn:shell.setNode");
});

test("a method without a handler answers not implemented", async () => {
  const ipc = fakeIpcMain();
  new IpcRegistry(isTrusted).install(ipc);
  const reply = await ipc.handlers.get("tavrn:keychain.keychainGet")?.(trusted, "alice@tavrn.example");
  assert.deepEqual(reply, { ok: false, error: "not implemented: keychainGet", notImplemented: true });
});

test("only the main window's own page may call; arguments are validated before the handler runs", async () => {
  const ipc = fakeIpcMain();
  const registry = new IpcRegistry(isTrusted);
  const calls: unknown[][] = [];
  registry.handle("shell", "setNode", check.args([check.string(300)], [check.nullableString(300), check.nullableString(253)]), (...args) => {
    calls.push(args);
    return "https://tavrn.example";
  });
  registry.install(ipc);
  const call = ipc.handlers.get("tavrn:shell.setNode");
  assert.deepEqual(await call?.(untrusted, "https://tavrn.example"), { ok: false, error: "ipc.forbidden" });
  assert.deepEqual(await call?.({ sender: "main", senderFrame: null }, "https://tavrn.example"), { ok: false, error: "ipc.forbidden" });
  for (const bad of [[], [42], ["x".repeat(301)], ["https://a.example", 1], ["https://a.example", null, null, "extra"]]) {
    assert.deepEqual(await call?.(trusted, ...bad), { ok: false, error: "ipc.invalid_arguments" }, JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await call?.(trusted, "https://tavrn.example"), { ok: true, value: "https://tavrn.example" });
  assert.deepEqual(await call?.(trusted, "https://tavrn.example", null, "tavrn.example"), { ok: true, value: "https://tavrn.example" });
  assert.equal(calls.length, 2);
});

test("refusals come back as the Tauri shell's values: codes and objects", async () => {
  const ipc = fakeIpcMain();
  const registry = new IpcRegistry(isTrusted);
  registry.handle("shell", "setNode", check.args([check.string(300)]), () => {
    throw new NodeUrlError("node_url.insecure");
  });
  registry.handle("shell", "resolveNode", check.args([check.string(300)]), async () => {
    throw { code: "resolve.not_found", step: "direct", domain: "nowhere.example" };
  });
  registry.handle("shell", "openExternal", check.args([check.string(2048)]), () => {
    throw "link.refused";
  });
  registry.install(ipc);
  assert.deepEqual(await ipc.handlers.get("tavrn:shell.setNode")?.(trusted, "http://evil"), { ok: false, error: "node_url.insecure" });
  assert.deepEqual(await ipc.handlers.get("tavrn:shell.resolveNode")?.(trusted, "nowhere.example"), { ok: false, error: { code: "resolve.not_found", step: "direct", domain: "nowhere.example" } });
  assert.deepEqual(await ipc.handlers.get("tavrn:shell.openExternal")?.(trusted, "file:///"), { ok: false, error: "link.refused" });
});

test("handlers exist only for methods of the bridge, once each", () => {
  const registry = new IpcRegistry(isTrusted);
  const none = check.args([]);
  // @ts-expect-error not a method of the bridge
  assert.throws(() => registry.handle("shell", "evalScript", none, () => null), /not a method/);
  registry.handle("shell", "getConfig", none, () => null);
  assert.throws(() => registry.handle("shell", "getConfig", none, () => null), /twice/);
});

test("argument checks", () => {
  assert.ok(check.args([check.bool], [check.int(0, 10)])([true]));
  assert.ok(check.args([check.bool], [check.int(0, 10)])([true, 3]));
  assert.ok(check.args([check.bool], [check.int(0, 10)])([true, undefined]));
  assert.ok(!check.args([check.bool], [check.int(0, 10)])([true, 11]));
  assert.ok(!check.args([check.bool], [check.int(0, 10)])([true, 1.5]));
  assert.ok(check.args([check.bytes(4)])([new Uint8Array(4)]));
  assert.ok(!check.args([check.bytes(4)])([new Uint8Array(5)]));
  assert.ok(!check.args([check.bytes(4)])([[1, 2]]));
  assert.ok(check.args([check.oneOf("a", "b")])(["b"]));
  assert.ok(!check.args([check.oneOf("a", "b")])(["c"]));
  assert.ok(check.args([check.record({ title: check.string(10), path: check.nullableString(10) })])([{ title: "t", path: null }]));
  assert.ok(!check.args([check.record({ title: check.string(10) })])([{ title: "t", extra: 1 }]), "unknown fields are refused");
  assert.ok(!check.args([check.record({ title: check.string(10) })])([null]));
  assert.ok(!check.args([check.record({ title: check.string(10) })])([["t"]]));
});
