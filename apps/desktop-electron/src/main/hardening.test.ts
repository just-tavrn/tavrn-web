// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_DEBUGGING_ENV, disableSpellChecker, refusedDebugSwitch } from "./hardening.ts";

test("the spellchecker is off in every session (no dictionary downloads)", () => {
  const calls: string[] = [];
  const ses = (name: string) => ({ setSpellCheckerEnabled: (on: boolean) => void calls.push(`${name}:${on}`) });
  disableSpellChecker([ses("default"), ses("connect")]);
  assert.deepEqual(calls, ["default:false", "connect:false"]);
});

test("a package refuses remote debugging unless the packaged specs allow it", () => {
  const has = (...names: string[]) => (n: string) => names.includes(n);
  assert.equal(refusedDebugSwitch(true, has("remote-debugging-port"), {}), "remote-debugging-port");
  assert.equal(refusedDebugSwitch(true, has("remote-debugging-pipe"), {}), "remote-debugging-pipe");
  assert.equal(refusedDebugSwitch(true, has(), {}), null);
  assert.equal(refusedDebugSwitch(false, has("remote-debugging-port"), {}), null);
  assert.equal(refusedDebugSwitch(true, has("remote-debugging-port"), { [ALLOW_DEBUGGING_ENV]: "1" }), null);
  assert.equal(refusedDebugSwitch(true, has("remote-debugging-port"), { [ALLOW_DEBUGGING_ENV]: "yes" }), "remote-debugging-port");
});
