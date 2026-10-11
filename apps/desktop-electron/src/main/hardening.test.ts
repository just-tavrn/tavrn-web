// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_DEBUGGING_ENV, disableSpellChecker, refusedDebugSwitch, seedNoSpellcheck } from "./hardening.ts";

test("the spellchecker is off in every session (no dictionary downloads)", () => {
  const calls: string[] = [];
  const ses = (name: string) => ({ setSpellCheckerEnabled: (on: boolean) => void calls.push(`${name}:${on}`), setSpellCheckerLanguages: (l: string[]) => void calls.push(`${name}:[${l}]`) });
  disableSpellChecker([ses("default"), ses("connect")]);
  assert.deepEqual(calls, ["default:false", "default:[]", "connect:false", "connect:[]"]);
});

test("the profiles start with the spellchecker off, before Chromium reads them", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tavrn-prefs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = join(dir, "fresh");
  const kept = join(dir, "kept");
  const corrupt = join(dir, "corrupt");
  seedNoSpellcheck([fresh]);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, "Preferences"), "utf8")), { spellcheck: { enabled: false, dictionaries: [], dictionary: "" } });
  seedNoSpellcheck([kept]);
  writeFileSync(join(kept, "Preferences"), JSON.stringify({ other: 1, spellcheck: { enabled: true, dictionaries: ["en-US"], x: 2 } }));
  seedNoSpellcheck([kept]);
  assert.deepEqual(JSON.parse(readFileSync(join(kept, "Preferences"), "utf8")), { other: 1, spellcheck: { enabled: false, dictionaries: [], dictionary: "", x: 2 } });
  seedNoSpellcheck([corrupt]);
  writeFileSync(join(corrupt, "Preferences"), "not json");
  seedNoSpellcheck([corrupt]);
  assert.equal(readFileSync(join(corrupt, "Preferences"), "utf8"), "not json", "a file Chromium may repair is left alone");
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
