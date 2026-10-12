// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIALOG_CSP, dialogAnswer, dialogContent, dialogHtml, dialogLabels, dialogUrl } from "./passkey_dialog.ts";

const en = dialogLabels("en-US");

test("the dialog's page runs no script and loads nothing", () => {
  assert.match(DIALOG_CSP, /script-src 'none'/);
  assert.match(DIALOG_CSP, /default-src 'none'/);
  const html = dialogHtml("en-US");
  assert.ok(html.includes(`content="${DIALOG_CSP}"`));
  assert.ok(!/<script/i.test(html));
  assert.match(html, /<html lang="en">/);
  assert.match(dialogHtml("de-DE"), /<html lang="de">/);
  assert.ok(dialogUrl("en").startsWith("data:text/html;charset=utf-8,"));
});

test("texts in English or German, with the same problems", () => {
  const de = dialogLabels("de-AT");
  assert.equal(de.cancel, "Abbrechen");
  assert.equal(dialogLabels("fr").cancel, "Cancel");
  assert.deepEqual(Object.keys(de.problems).sort(), Object.keys(en.problems).sort());
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
});

test("the content of each step names the relying party and what to do", () => {
  const waiting = dialogContent({ view: "waiting" }, en, "create", "tavrn.example");
  assert.equal(waiting.title, "Create a passkey for tavrn.example");
  assert.match(waiting.message, /Plug in your security key/);
  assert.deepEqual([waiting.pin, waiting.alert, waiting.final, waiting.cancel], [null, null, false, "Cancel"]);
  assert.equal(dialogContent({ view: "touch" }, en, "get", "tavrn.example").title, "Use your passkey for tavrn.example");
  const pin = dialogContent({ view: "pin", invalid: false, retries: null, length: false }, en, "get", "tavrn.example");
  assert.deepEqual(pin.pin, { label: "PIN of the security key", submit: "Continue" });
  assert.equal(pin.alert, null);
  assert.equal(dialogContent({ view: "pin", invalid: true, retries: 2, length: false }, en, "get", "r").alert, "Wrong PIN. 2 tries left before the key locks.");
  assert.equal(dialogContent({ view: "pin", invalid: true, retries: null, length: false }, en, "get", "r").alert, "Wrong PIN. Try again.");
  assert.match(dialogContent({ view: "pin", invalid: false, retries: null, length: true }, en, "get", "r").alert ?? "", /at least 4/);
  const accounts = dialogContent({ view: "accounts", names: ["Alice", ""] }, en, "get", "tavrn.example");
  assert.deepEqual(accounts.accounts, ["Use the passkey of Alice", "Use the passkey of ?"]);
  assert.match(dialogContent({ view: "uv_invalid", retries: 1 }, en, "get", "r").alert ?? "", /did not recognize/);
  const blocked = dialogContent({ view: "problem", problem: "pin_blocked" }, en, "get", "r");
  assert.deepEqual([blocked.final, blocked.cancel], [true, "Close"]);
  assert.match(blocked.alert ?? "", /blocked/);
  assert.equal(dialogContent({ view: "problem", problem: "else" }, en, "get", "r").alert, en.problem_other);
});

test("the preload's answers are checked", () => {
  assert.deepEqual(dialogAnswer({ type: "pin", pin: "1234" }, 0), { type: "pin", pin: "1234" });
  assert.deepEqual(dialogAnswer({ type: "account", index: 1 }, 2), { type: "account", index: 1 });
  for (const bad of [null, "pin", { type: "pin", pin: 1234 }, { type: "pin", pin: "x".repeat(300) }, { type: "account", index: 2 }, { type: "account", index: -1 }, { type: "account", index: 0.5 }, { type: "other" }]) {
    assert.deepEqual(dialogAnswer(bad, 2), { type: "cancel" }, JSON.stringify(bad));
  }
});
