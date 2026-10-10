// SPDX-License-Identifier: Apache-2.0
// Native notifications (the Tauri shell's notify.rs cases) with a fake of Electron's Notification.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BridgeEvent } from "./events.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import { MAX_BODY, MAX_PATH, MAX_TITLE, MAX_WAITING, Notifier, registerNotifyHandlers, validateNotice, type NotificationLike, type NotificationOptions } from "./notify.ts";

const notice = (title: string, body: string, path: string | null = null) => ({ title, body, path });

test("ordinary notices pass", () => {
  validateNotice(notice("Alice in #general · Room", "Hello there", "/rooms/1/channels/2"));
  validateNotice(notice("Incoming call from bob", "bob@tavrn.example", "/n/other.example/dm/3"));
  validateNotice(notice("Alice", "line one\nline two"));
});

test("paths stay inside the client", () => {
  for (const bad of ["https://evil.example/", "//evil.example/x", "rooms/1", "/rooms/1 x", "/a\\b", "javascript:alert(1)", "", "/a\u0000b", "/a b"]) {
    assert.throws(() => validateNotice(notice("t", "b", bad)), (e) => e === "notify.invalid", JSON.stringify(bad));
  }
  assert.throws(() => validateNotice(notice("t", "b", `/${"a".repeat(MAX_PATH)}`)), (e) => e === "notify.invalid");
  assert.throws(() => validateNotice(notice("t", "b", `/${"ü".repeat(MAX_PATH / 2)}`)), (e) => e === "notify.invalid", "bytes, as the Tauri shell counts");
});

test("titles and bodies are bounded", () => {
  for (const [title, body] of [
    ["", "b"],
    ["   ", "b"],
    ["t".repeat(MAX_TITLE + 1), "b"],
    ["t", "b".repeat(MAX_BODY + 1)],
    ["t\u0007", "b"],
    ["t", "b\u001b[31m"],
    ["t", "b\u0085"],
  ] as const) {
    assert.throws(() => validateNotice(notice(title, body)), (e) => e === "notify.invalid", JSON.stringify([title, body]));
  }
  validateNotice(notice("ü".repeat(MAX_TITLE), "b"));
  validateNotice(notice("😀".repeat(MAX_TITLE), "b"));
});

class FakeNotification implements NotificationLike {
  static made: FakeNotification[] = [];
  readonly options: NotificationOptions;
  readonly listeners = new Map<string, Array<() => void>>();
  shown = false;
  constructor(options: NotificationOptions) {
    this.options = options;
    FakeNotification.made.push(this);
  }
  on(event: "click" | "close" | "failed", fn: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  show() {
    this.shown = true;
  }
  emit(event: string) {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }
}

function setup(supported = true) {
  FakeNotification.made = [];
  const sent: BridgeEvent[] = [];
  let shownMain = 0;
  const notifier = new Notifier({
    create: (o) => new FakeNotification(o),
    supported: () => supported,
    showMain: () => void shownMain++,
    events: { send: (e) => (sent.push(e), true) },
    icon: "/app/icons/icon.png",
  });
  return { notifier, sent, shownMain: () => shownMain };
}

test("a notification shows title, body and the app icon; a click focuses the window and opens its path", () => {
  const { notifier, sent, shownMain } = setup();
  notifier.notify(notice("Alice", "Hello", "/rooms/1/channels/2"));
  const [n] = FakeNotification.made;
  assert.ok(n?.shown);
  assert.deepEqual(n.options, { title: "Alice", body: "Hello", icon: "/app/icons/icon.png" });
  assert.equal(notifier.waiting, 1);
  n.emit("click");
  assert.equal(shownMain(), 1);
  assert.deepEqual(sent, [{ channel: "shell_events", event: { kind: "open", path: "/rooms/1/channels/2" } }]);
  assert.equal(notifier.waiting, 0, "a clicked notification is let go");
});

test("a click without a path only focuses the window; a closed notification is let go", () => {
  const { notifier, sent, shownMain } = setup();
  notifier.notify(notice("Alice", "Hello"));
  FakeNotification.made[0]?.emit("click");
  assert.equal(shownMain(), 1);
  assert.deepEqual(sent, []);
  notifier.notify(notice("Bob", "Hi", "/dm/1"));
  FakeNotification.made[1]?.emit("close");
  assert.equal(notifier.waiting, 0);
  FakeNotification.made[1]?.emit("failed");
  assert.equal(notifier.waiting, 0);
});

test("at most 16 notifications wait for a click; more are still shown", () => {
  const { notifier } = setup();
  for (let i = 0; i < MAX_WAITING + 4; i++) notifier.notify(notice(`n${i}`, "b", "/"));
  assert.equal(FakeNotification.made.length, MAX_WAITING + 4);
  assert.ok(FakeNotification.made.every((n) => n.shown));
  assert.equal(notifier.waiting, MAX_WAITING);
  assert.equal(FakeNotification.made.at(-1)?.listeners.size, 0, "not waited for");
});

test("without a notification server nothing is shown and nothing fails (as the Tauri shell)", () => {
  const { notifier } = setup(false);
  notifier.notify(notice("Alice", "Hello", "/"));
  assert.equal(FakeNotification.made.length, 0);
});

const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

test("the handler validates at the IPC boundary and in the notifier", async () => {
  const { notifier } = setup();
  const registry = new IpcRegistry((e) => e === me);
  registerNotifyHandlers(registry, { notifier });
  const call = (...args: unknown[]) => registry.dispatch("tavrn:notify.notify", "notify", me, args);
  assert.deepEqual(await call({ title: "Alice", body: "Hello", path: "/rooms/1" }), { ok: true, value: undefined });
  assert.deepEqual(await call({ title: "Alice", body: "Hello" }), { ok: true, value: undefined }, "the path may be left out");
  assert.deepEqual(await call({ title: "Alice", body: "Hello", path: "https://evil.example/" }), { ok: false, error: "notify.invalid" });
  assert.deepEqual(await call({ title: "", body: "Hello", path: null }), { ok: false, error: "notify.invalid" });
  assert.deepEqual(await call({ title: "Alice", body: "Hello", path: null, icon: "/etc/passwd" }), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call({ title: 1, body: "Hello", path: null }), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call("Alice"), { ok: false, error: "ipc.invalid_arguments" });
  assert.deepEqual(await call({ title: "x".repeat(100_000), body: "", path: null }), { ok: false, error: "ipc.invalid_arguments" });
  assert.equal(FakeNotification.made.length, 2);
});
