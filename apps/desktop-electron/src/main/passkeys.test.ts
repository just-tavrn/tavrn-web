// SPDX-License-Identifier: Apache-2.0
// The passkeys of the Linux app with a fake native module and a recording dialog: the origin from the settings, the
// events in the dialog, the PIN and the choices back to the module, cancels, refusals as the Windows app's codes, the
// bridge's handlers and their argument checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import type { DialogAnswer, DialogView } from "./passkey_dialog.ts";
import { codeOf, MAX_OPTIONS, optionsCheck, parseEvent, parseResult, Passkeys, registerPasskeyHandlers, relyingParty, validPin, viewOf, type Ceremony, type PasskeyNative, type PasskeyPrompt } from "./passkeys.ts";

const ORIGIN = "https://app.tavrn.example";
const OPTIONS = { publicKey: { challenge: "AAAA", rpId: "tavrn.example" } };
const RESULT = JSON.stringify({ credential: { id: "Y3JlZA", rawId: "Y3JlZA", type: "public-key" }, prf: "BQUF" });

/** A native module whose ceremonies the test drives: `emit` an event, `finish` with an error or a result. */
function fakeNative(available = true) {
  const calls: Array<{ ceremony: Ceremony; options: string; origin: string }> = [];
  const pins: Array<string | null> = [];
  const accounts: Array<number | null> = [];
  let cancels = 0;
  let current: { onEvent: (e: string) => void; onDone: (e: string | null, r: string | null) => void } | null = null;
  const run = (ceremony: Ceremony) => (options: string, origin: string, onEvent: (e: string) => void, onDone: (e: string | null, r: string | null) => void) => {
    if (options.includes("refuse-me")) throw new Error("passkey.refused");
    calls.push({ ceremony, options, origin });
    current = { onEvent, onDone };
  };
  const native: PasskeyNative = {
    available: () => available,
    keys: () => ({ present: 2, usable: 1 }),
    create: run("create"),
    get: run("get"),
    pin: (pin) => (pins.push(pin), true),
    account: (index) => (accounts.push(index), true),
    cancel: () => {
      cancels += 1;
      current?.onDone("passkey.cancelled", null);
    },
  };
  return {
    native,
    calls,
    pins,
    accounts,
    cancels: () => cancels,
    emit: (e: unknown) => current?.onEvent(JSON.stringify(e)),
    finish: (error: string | null, result: string | null = null) => current?.onDone(error, result),
  };
}

/** A dialog that records what it shows; `answer` plays the user. */
function fakePrompt() {
  const shown: DialogView[] = [];
  const opened: Array<{ ceremony: Ceremony; rp: string }> = [];
  let answer: ((a: DialogAnswer) => void) | null = null;
  let done = 0;
  const prompt: PasskeyPrompt = {
    open: (ceremony, rp, a) => {
      opened.push({ ceremony, rp });
      answer = a;
    },
    show: (view) => shown.push(view),
    done: () => {
      done += 1;
    },
  };
  return { prompt, shown, opened, answer: (a: DialogAnswer) => answer?.(a), done: () => done };
}

test("a ceremony runs for the node's web origin of the settings, shows its steps and answers the credential", async () => {
  const n = fakeNative();
  const d = fakePrompt();
  const passkeys = new Passkeys({ native: n.native, origin: () => ORIGIN, prompt: d.prompt });
  const running = passkeys.run("get", OPTIONS);
  assert.deepEqual(n.calls, [{ ceremony: "get", options: JSON.stringify(OPTIONS), origin: ORIGIN }]);
  assert.deepEqual(d.opened, [{ ceremony: "get", rp: "tavrn.example" }]);
  n.emit({ kind: "select_key" });
  n.emit({ kind: "pin", invalid: false, retries: null });
  d.answer({ type: "pin", pin: "123" });
  assert.deepEqual(n.pins, [], "a PIN the key would refuse is not sent");
  d.answer({ type: "pin", pin: "123456" });
  n.emit({ kind: "pin", invalid: true, retries: 3 });
  n.emit({ kind: "touch" });
  n.emit({ kind: "unknown" });
  n.finish(null, RESULT);
  assert.deepEqual(await running, { credential: { id: "Y3JlZA", rawId: "Y3JlZA", type: "public-key" }, prf: "BQUF" });
  assert.deepEqual(n.pins, ["123456"]);
  assert.deepEqual(d.shown, [
    { view: "select_key" },
    { view: "pin", invalid: false, retries: null, length: false },
    { view: "pin", invalid: false, retries: null, length: true },
    { view: "pin", invalid: true, retries: 3, length: false },
    { view: "touch" },
  ]);
  assert.equal(d.done(), 1);
});

test("the user's choice of a passkey and a cancel reach the module", async () => {
  const n = fakeNative();
  const d = fakePrompt();
  const passkeys = new Passkeys({ native: n.native, origin: () => ORIGIN, prompt: d.prompt });
  const running = passkeys.run("get", OPTIONS);
  n.emit({ kind: "accounts", names: ["Alice", 42] });
  assert.deepEqual(d.shown.at(-1), { view: "accounts", names: ["Alice", ""] });
  d.answer({ type: "account", index: 1 });
  assert.deepEqual(n.accounts, [1]);
  d.answer({ type: "cancel" });
  await assert.rejects(running, (e) => e === "passkey.cancelled");
  assert.equal(n.cancels(), 1);
  assert.equal(d.done(), 1);
  // Answers after the end change nothing.
  d.answer({ type: "cancel" });
  assert.equal(n.cancels(), 1);
});

test("one ceremony at a time; refusals are the Windows app's codes", async () => {
  const n = fakeNative();
  const d = fakePrompt();
  const passkeys = new Passkeys({ native: n.native, origin: () => ORIGIN, prompt: d.prompt });
  const first = passkeys.run("create", { publicKey: { rp: { id: "tavrn.example" } } });
  await assert.rejects(passkeys.run("get", OPTIONS), (e) => e === "passkey.failed");
  n.finish("passkey.exists");
  await assert.rejects(first, (e) => e === "passkey.exists");
  // The module refuses options at once (an rp id outside the origin).
  await assert.rejects(passkeys.run("get", { publicKey: { challenge: "refuse-me" } }), (e) => e === "passkey.refused");
  assert.equal(d.opened.length, 1, "no dialog for options the module refuses");
  // An answer without a credential, an odd error.
  const odd = passkeys.run("get", OPTIONS);
  n.finish(null, "{}");
  await assert.rejects(odd, (e) => e === "passkey.failed");
  const weird = passkeys.run("get", OPTIONS);
  n.finish("kaboom");
  await assert.rejects(weird, (e) => e === "passkey.failed");
});

test("no node yet, no module: refused before any dialog", async () => {
  const d = fakePrompt();
  const log: string[] = [];
  const none = new Passkeys({ native: { unavailable: "not built" }, origin: () => ORIGIN, prompt: d.prompt, log: (m) => log.push(m) });
  await assert.rejects(none.run("get", OPTIONS), (e) => e === "passkey.unavailable");
  assert.deepEqual(none.status(), { available: false, present: 0, usable: 0 });
  assert.match(log[0] ?? "", /no native passkeys: not built/);
  const noNode = new Passkeys({ native: fakeNative().native, origin: () => null, prompt: d.prompt });
  await assert.rejects(noNode.run("get", OPTIONS), (e) => e === "passkey.refused");
  assert.equal(d.opened.length, 0);
  assert.deepEqual(noNode.status(), { available: true, present: 2, usable: 1 });
  assert.deepEqual(new Passkeys({ native: fakeNative(false).native, origin: () => ORIGIN, prompt: d.prompt }).status(), { available: false, present: 0, usable: 0 });
});

test("events, results, PINs and relying parties are read defensively", () => {
  assert.deepEqual(parseEvent('{"kind":"pin","invalid":true,"retries":300}'), { kind: "pin", invalid: true, retries: null });
  assert.deepEqual(parseEvent('{"kind":"problem","problem":"pin_blocked"}'), { kind: "problem", problem: "pin_blocked" });
  assert.equal(parseEvent("not json"), null);
  assert.equal(parseEvent('{"kind":"accounts","names":"x"}'), null);
  assert.deepEqual(viewOf({ kind: "uv_invalid", retries: 2 }), { view: "uv_invalid", retries: 2 });
  assert.throws(() => parseResult(null), (e) => e === "passkey.failed");
  assert.throws(() => parseResult('{"credential":{"id":1}}'), (e) => e === "passkey.failed");
  assert.deepEqual(parseResult('{"credential":{"id":"x"}}'), { credential: { id: "x" }, prf: null });
  assert.equal(codeOf(new Error("passkey.exists")), "passkey.exists");
  assert.equal(codeOf("passkey.cancelled"), "passkey.cancelled");
  assert.equal(codeOf({}), "passkey.failed");
  assert.ok(validPin("1234") && validPin("äöüß") && validPin("x".repeat(63)));
  assert.ok(!validPin("123") && !validPin("x".repeat(64)) && !validPin("ü".repeat(32)), "63 bytes at most");
  assert.equal(relyingParty({ publicKey: { rp: { id: "tavrn.example" } } }, ORIGIN), "tavrn.example");
  assert.equal(relyingParty({ publicKey: { rpId: "tavrn.example" } }, ORIGIN), "tavrn.example");
  assert.equal(relyingParty({ publicKey: {} }, ORIGIN), "app.tavrn.example");
});

const trusted: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

test("the bridge's handlers: create, get and status, with their argument checks", async () => {
  const n = fakeNative();
  const registry = new IpcRegistry((e) => e === trusted);
  registerPasskeyHandlers(registry, { passkeys: new Passkeys({ native: n.native, origin: () => ORIGIN, prompt: fakePrompt().prompt }) });
  assert.deepEqual(await registry.dispatch("tavrn:passkeys.passkeyStatus", "passkeyStatus", trusted, []), { ok: true, value: { available: true, present: 2, usable: 1 } });
  const created = registry.dispatch("tavrn:passkeys.passkeyCreate", "passkeyCreate", trusted, [OPTIONS]);
  n.finish(null, RESULT);
  assert.deepEqual(await created, { ok: true, value: JSON.parse(RESULT) });
  const refused = registry.dispatch("tavrn:passkeys.passkeyGet", "passkeyGet", trusted, [OPTIONS]);
  n.finish("passkey.cancelled");
  assert.deepEqual(await refused, { ok: false, error: "passkey.cancelled" });
  const cyclic: Record<string, unknown> = { publicKey: {} };
  (cyclic.publicKey as Record<string, unknown>).self = cyclic;
  for (const bad of [[], [null], ["{}"], [[]], [{}], [{ publicKey: "x" }], [{ publicKey: { pad: "x".repeat(MAX_OPTIONS) } }], [cyclic], [OPTIONS, OPTIONS]]) {
    assert.deepEqual(await registry.dispatch("tavrn:passkeys.passkeyGet", "passkeyGet", trusted, bad), { ok: false, error: "ipc.invalid_arguments" });
  }
  assert.equal(n.calls.length, 2);
  assert.ok(optionsCheck(OPTIONS));
  assert.deepEqual(await registry.dispatch("tavrn:passkeys.passkeyGet", "passkeyGet", { sender: "x", senderFrame: null }, [OPTIONS]), { ok: false, error: "ipc.forbidden" });
});
