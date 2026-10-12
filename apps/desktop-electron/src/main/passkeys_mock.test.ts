// SPDX-License-Identifier: Apache-2.0
// The software security key of the Playwright specs: what the environment asks for, its CBOR, registration and
// assertion as a FIDO2 key writes them (the signature verifies with the credential's key over authenticatorData and the
// hash of the shell's clientDataJSON), the PIN with its retries, the choice between passkeys, the PRF, a cancel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { cbor, SoftKey, softKeyFromEnv, TEST_PASSKEYS_ENV } from "./passkeys_mock.ts";

const ORIGIN = "https://app.tavrn.example";
const b64 = (s: string) => Buffer.from(s, "base64url");

interface Run {
  events: Array<Record<string, unknown>>;
  done: Promise<{ error: string | null; result: { credential: Record<string, any>; prf: string | null } | null }>;
}

function run(key: SoftKey, ceremony: "create" | "get", publicKey: Record<string, unknown>, origin = ORIGIN): Run {
  const events: Array<Record<string, unknown>> = [];
  const done = new Promise<Run["done"] extends Promise<infer T> ? T : never>((resolve) =>
    key[ceremony](JSON.stringify({ publicKey }), origin, (e) => events.push(JSON.parse(e) as Record<string, unknown>), (error, result) => resolve({ error, result: result ? JSON.parse(result) : null })),
  );
  return { events, done };
}

const creation = (user = "AQID", name = "alice") => ({
  rp: { id: "tavrn.example", name: "tavrn" },
  user: { id: user, name, displayName: name.toUpperCase() },
  challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZQ",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { userVerification: "discouraged" },
  extensions: { prf: { eval: { first: "AQ" } } },
});
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("the environment chooses the key; nothing without it", () => {
  assert.equal(softKeyFromEnv({}), null);
  assert.ok(softKeyFromEnv({ [TEST_PASSKEYS_ENV]: "nopin" }));
  assert.ok(softKeyFromEnv({ [TEST_PASSKEYS_ENV]: "pin=4321" }));
  assert.equal(softKeyFromEnv({ [TEST_PASSKEYS_ENV]: "pin=12" }), null);
  assert.equal(softKeyFromEnv({ [TEST_PASSKEYS_ENV]: "yes" }), null);
});

test("CBOR as the key writes it", () => {
  assert.deepEqual(cbor(0), Buffer.from([0x00]));
  assert.deepEqual(cbor(-7), Buffer.from([0x26]));
  assert.deepEqual(cbor(500), Buffer.from([0x19, 0x01, 0xf4]));
  assert.deepEqual(cbor("fmt"), Buffer.from([0x63, 0x66, 0x6d, 0x74]));
  assert.deepEqual(cbor(new Uint8Array([1, 2])), Buffer.from([0x42, 1, 2]));
  assert.deepEqual(cbor({}), Buffer.from([0xa0]));
  assert.deepEqual(cbor(new Map([[1, 2]])), Buffer.from([0xa1, 0x01, 0x02]));
});

test("a registration and an assertion as a FIDO2 key makes them, signed for the shell's clientDataJSON", async () => {
  const key = new SoftKey(null);
  const reg = await run(key, "create", creation()).done;
  assert.equal(reg.error, null);
  const c = reg.result!.credential;
  assert.deepEqual(JSON.parse(b64(c.response.clientDataJSON).toString()), { type: "webauthn.create", challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZQ", origin: ORIGIN, crossOrigin: false });
  assert.deepEqual(c.clientExtensionResults, { credProps: { rk: true }, prf: { enabled: true } });
  const att = b64(c.response.attestationObject);
  assert.ok(att.includes(Buffer.from("none")) && att.includes(createHash("sha256").update("tavrn.example").digest()));
  const got = await run(key, "get", { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "tavrn.example", allowCredentials: [{ type: "public-key", id: c.id }], extensions: { prf: { eval: { first: "AQ" } } } }).done;
  const a = got.result!.credential;
  const clientData = b64(a.response.clientDataJSON);
  assert.equal(JSON.parse(clientData.toString()).type, "webauthn.get");
  const signed = Buffer.concat([b64(a.response.authenticatorData), createHash("sha256").update(clientData).digest()]);
  assert.ok(verify("sha256", signed, key.publicKeyOf(c.id)!, b64(a.response.signature)), "the signature verifies");
  assert.equal(b64(a.response.authenticatorData).readUInt32BE(33), 1, "the counter counts");
  assert.equal(a.response.userHandle, "AQID");
  assert.equal(b64(got.result!.prf!).length, 32);
  const again = await run(key, "get", { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "tavrn.example", extensions: { prf: { eval: { first: "AQ" } } } }).done;
  assert.equal(again.result!.prf, got.result!.prf, "the same PRF output for the same input");
  // Only the relying party's origin; an excluded key refuses a second passkey.
  assert.throws(() => key.get(JSON.stringify({ publicKey: { challenge: "AA", rpId: "tavrn.example" } }), "https://evil.example", () => {}, () => {}), /passkey\.refused/);
  const twice = await run(key, "create", { ...creation(), excludeCredentials: [{ type: "public-key", id: c.id }] }).done;
  assert.equal(twice.error, "passkey.exists");
});

test("the PIN with its retries, the choice between passkeys and a cancel", async () => {
  const key = new SoftKey("4321");
  const first = run(key, "create", { ...creation("AQID", "alice"), authenticatorSelection: { userVerification: "required" } });
  await until(() => first.events.length > 0);
  assert.deepEqual(first.events[0], { kind: "pin", invalid: false, retries: null });
  assert.equal(key.pin("1111"), true);
  await until(() => first.events.length > 1);
  assert.deepEqual(first.events[1], { kind: "pin", invalid: true, retries: 7 });
  key.pin("4321");
  assert.equal((await first.done).error, null);
  assert.deepEqual(first.events.at(-1), { kind: "touch" });
  await run(key, "create", { ...creation("BAUG", "bob"), authenticatorSelection: { userVerification: "discouraged" } }).done;
  const choose = run(key, "get", { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "tavrn.example", userVerification: "discouraged" });
  await until(() => choose.events.some((e) => e.kind === "accounts"));
  assert.deepEqual(choose.events.at(-1), { kind: "accounts", names: ["ALICE", "BOB"] });
  assert.equal(key.account(1), true);
  assert.equal((await choose.done).result!.credential.response.userHandle, "BAUG");
  const cancelled = run(key, "get", { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "tavrn.example", userVerification: "required" });
  await until(() => cancelled.events.length > 0);
  assert.throws(() => key.get(JSON.stringify({ publicKey: { challenge: "AA" } }), ORIGIN, () => {}, () => {}), /passkey\.failed/, "one at a time");
  key.cancel();
  assert.equal((await cancelled.done).error, "passkey.cancelled");
  assert.equal(key.pin("4321"), false, "nothing waits after the cancel");
});
