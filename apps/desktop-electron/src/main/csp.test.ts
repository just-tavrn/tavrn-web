// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSP_DIRECTIVES, contentSecurityPolicy } from "./csp.ts";

const tauri = JSON.parse(readFileSync(new URL("../../../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
  app: { security: { csp: Record<string, string> } };
};

test("the policy is the Tauri shell's, without Tauri's own IPC origins", () => {
  const theirs = tauri.app.security.csp;
  assert.deepEqual(Object.keys(CSP_DIRECTIVES).sort(), Object.keys(theirs).sort());
  for (const [name, value] of Object.entries(theirs)) {
    const expected = name === "connect-src" ? value.replace(" ipc: http://ipc.localhost", "") : value;
    assert.equal(CSP_DIRECTIVES[name], expected, name);
  }
});

test("scripts only from the bundle: no eval, no inline scripts, no remote scripts", () => {
  assert.equal(CSP_DIRECTIVES["script-src"], "'self' 'wasm-unsafe-eval'");
  assert.equal(CSP_DIRECTIVES["object-src"], "'none'");
  for (const value of Object.values(CSP_DIRECTIVES)) assert.ok(!value.includes("'unsafe-eval'"));
});

test("serializes every directive once", () => {
  const csp = contentSecurityPolicy();
  assert.match(csp, /^default-src 'self'; /);
  assert.equal(csp.split("; ").length, Object.keys(CSP_DIRECTIVES).length);
  assert.ok(csp.includes("connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*"));
});
