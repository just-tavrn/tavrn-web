// SPDX-License-Identifier: Apache-2.0
// The built Node-API module (pnpm run build): its refusals before any key is asked, the key count, and a ceremony that
// waits for a key and is cancelled (no security key is needed: the ceremony waits for one until it is cancelled).
// Skipped before the module is built. A real key cannot be tested here (docs/DESKTOP.md "Passkeys on Linux").
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const file = new URL("../passkeys.linux-x64-gnu.node", import.meta.url);
const built = existsSync(file);
const passkeys = built ? createRequire(import.meta.url)(file.pathname) : null;
const skip = !built && "not built";

const ORIGIN = "https://app.tavrn.example";
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const request = (rpId = "tavrn.example") => JSON.stringify({ publicKey: { challenge: b64url(new Uint8Array(32).fill(1)), rpId, allowCredentials: [{ type: "public-key", id: b64url([1, 2, 3]) }], userVerification: "required", timeout: 30000 } });
const noop = () => {};

test("options and origins the shell refuses never reach a key", { skip }, () => {
  assert.equal(passkeys.available(), true);
  assert.throws(() => passkeys.get("{}", ORIGIN, noop, noop), /passkey\.failed/);
  assert.throws(() => passkeys.get("not json", ORIGIN, noop, noop), /passkey\.failed/);
  assert.throws(() => passkeys.get("x".repeat(70000), ORIGIN, noop, noop), /passkey\.failed/);
  assert.throws(() => passkeys.get(request("evil.example"), ORIGIN, noop, noop), /passkey\.refused/);
  assert.throws(() => passkeys.get(request(), "http://app.tavrn.example", noop, noop), /passkey\.refused/);
  assert.throws(() => passkeys.create(JSON.stringify({ publicKey: {} }), ORIGIN, noop, noop), /passkey\.failed/);
  const keys = passkeys.keys();
  assert.ok(Number.isInteger(keys.present) && Number.isInteger(keys.usable) && keys.usable <= keys.present);
  assert.equal(passkeys.pin("123456"), false, "no key waits for a PIN");
  assert.equal(passkeys.account(0), false);
  passkeys.cancel();
});

test("a ceremony waits for a key, one at a time, and a cancel ends it as cancelled", { skip }, async () => {
  const done = new Promise((resolve) => passkeys.get(request(), ORIGIN, noop, (error, result) => resolve({ error, result })));
  assert.throws(() => passkeys.get(request(), ORIGIN, noop, noop), /passkey\.failed/, "a second ceremony is refused");
  await new Promise((r) => setTimeout(r, 200));
  passkeys.cancel();
  assert.deepEqual(await done, { error: "passkey.cancelled", result: null });
  // The next ceremony may start.
  const again = new Promise((resolve) => passkeys.get(request(), ORIGIN, noop, (error) => resolve(error)));
  passkeys.cancel();
  assert.equal(await again, "passkey.cancelled");
});
