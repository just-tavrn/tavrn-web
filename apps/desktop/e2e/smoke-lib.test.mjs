// SPDX-License-Identifier: Apache-2.0
// node --test: the helpers of the WebDriver smoke test (smoke.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appProcessPattern, cbor, childEnv, keptUnlockKey, servesWebClient, softPasskeyRegistration } from "./smoke-lib.mjs";

test("the app renders on xvfb's X display, never on a Wayland desktop", () => {
  const env = childEnv({ DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", GDK_BACKEND: "wayland", PATH: "/usr/bin" }, { TAVRN_DESKTOP_KEYCHAIN: "memory" });
  assert.equal(env.GDK_BACKEND, "x11");
  assert.equal("WAYLAND_DISPLAY" in env, false);
  assert.equal(env.DISPLAY, ":99");
  assert.equal(env.TAVRN_DESKTOP_KEYCHAIN, "memory");
  assert.equal(env.PATH, "/usr/bin");
});

test("a node without its web client is recognized", () => {
  assert.equal(servesWebClient("Web client not embedded (web/dist missing at build time). The API runs under /api/v1."), false);
  assert.equal(servesWebClient(""), false);
  assert.equal(servesWebClient('<!doctype html><html lang="en"><head><title>tavrn</title></head><body><div id="root"></div></body></html>'), true);
});

test("running instances are matched by the exact app binary", () => {
  const re = new RegExp(`^${appProcessPattern("/opt/build.1/release/tavrn")}$`);
  assert.ok(re.test("/opt/build.1/release/tavrn"));
  assert.ok(re.test("/opt/build.1/release/tavrn --flag"));
  assert.ok(!re.test("/opt/buildX1/release/tavrn"), "dots are literal");
  assert.ok(!re.test("/opt/build.1/release/tavrn-node --dev"));
  assert.ok(!re.test("node smoke.mjs /opt/build.1/release/tavrn"));
});

test("CBOR of the shapes WebAuthn needs (RFC 8949 appendix A)", () => {
  const hex = (v) => cbor(v).toString("hex");
  assert.equal(hex(0), "00");
  assert.equal(hex(23), "17");
  assert.equal(hex(24), "1818");
  assert.equal(hex(500), "1901f4");
  assert.equal(hex(-1), "20");
  assert.equal(hex(-7), "26");
  assert.equal(hex("a"), "6161");
  assert.equal(hex(new Uint8Array([1, 2, 3, 4])), "4401020304");
  assert.equal(hex(new Map([[1, 2], [3, 4]])), "a201020304");
  assert.equal(hex(new Map()), "a0");
  assert.throws(() => cbor(null));
});

test("the software passkey's registration: attestation none, flags UP | UV | AT, ES256, PRF enabled", () => {
  const { credentialId, credential } = softPasskeyRegistration({ rpId: "localhost", origin: "http://localhost:8300", challenge: "Y2hhbGxlbmdl" });
  assert.equal(credential.id, credentialId);
  assert.equal(Buffer.from(credentialId, "base64url").length, 16);
  assert.deepEqual(credential.clientExtensionResults, { prf: { enabled: true } });
  const client = JSON.parse(Buffer.from(credential.response.clientDataJSON, "base64url").toString());
  assert.deepEqual(client, { type: "webauthn.create", challenge: "Y2hhbGxlbmdl", origin: "http://localhost:8300", crossOrigin: false });
  const att = Buffer.from(credential.response.attestationObject, "base64url");
  // {"fmt": "none", "attStmt": {}, "authData": bytes}
  assert.equal(att.subarray(0, 10).toString("hex"), "a363666d74646e6f6e65");
  assert.equal(att.subarray(10, 18).toString(), "gattStmt");
  // "authData" (8 bytes), then the byte string head 0x58 <length>.
  const authData = att.subarray(att.indexOf(Buffer.from("authData")) + 8 + 2);
  assert.equal(authData[32], 0x45);
  assert.equal(authData.readUInt16BE(53), 16);
  assert.equal(authData.subarray(55, 71).toString("base64url"), credentialId);
});

test("the unlock key the sign-in page kept", () => {
  const id = "S".repeat(43);
  const key = "K".repeat(43);
  assert.deepEqual(keptUnlockKey([["other", "x"], [`tavrn.connect.key.${id}`, key]]), [id, key]);
  assert.equal(keptUnlockKey([[`tavrn.connect.key.${id}`, "short"]]), null);
  assert.equal(keptUnlockKey([]), null);
});
