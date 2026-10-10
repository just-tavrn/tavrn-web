// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { keyIdHex, MinisignError, parsePublicKey, verifyMinisign } from "./minisign.ts";
import { minisignKeyPair } from "./minisign.fixture.ts";

const feed = Buffer.from("version: 0.3.0\nfiles:\n  - url: a\n");

// Made by the Tauri CLI (`tauri signer generate`, then `tauri signer sign --app-version 0.3.0 latest-linux.yml`) with a
// throwaway key whose secret half was discarded: the real signer's output, as the release workflow produces it.
const TAURI_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUwMkM3MTY1MTM1ODIxNUIKUldSYklWZ1RaWEVzVU5SaGE4SWJleVdrWll0UDkwSHVHb0djQ2NWVHV2ejd1VUIzZWo2cEdYVzMK";
const TAURI_SIG = [
  "untrusted comment: signature from tauri secret key",
  "RURbIVgTZXEsUGOnIFFw4taddqz/hJaPSYIA0AymfeZtOBm8Se1hQhEc1yV9spG1XjSGUek4pI0O+AQcPSKgHvq4hnrop8Ty9AE=",
  "trusted comment: timestamp:1791658999\tfile:latest-linux.yml\tversion:0.3.0",
  "yW3Rku5cWF/AujJlrMoVYpU8NfzBWSo6ZeUrpQRJzthYrxB3HJB6LqTkuWnVyCcvl9mKzFPsreNAZopheJS7AQ==",
  "",
].join("\n");

test("verifies what the Tauri CLI signs, in every form of the public key", () => {
  for (const form of [TAURI_PUBKEY, Buffer.from(TAURI_PUBKEY, "base64").toString(), Buffer.from(TAURI_PUBKEY, "base64").toString().split("\n")[1]!]) {
    const v = verifyMinisign(feed, TAURI_SIG, parsePublicKey(form));
    assert.deepEqual(v.fields, { timestamp: "1791658999", file: "latest-linux.yml", version: "0.3.0" });
  }
  // The `.sig` form (the signature file base64-encoded once more) parses too.
  assert.equal(verifyMinisign(feed, Buffer.from(TAURI_SIG).toString("base64"), parsePublicKey(TAURI_PUBKEY)).fields.version, "0.3.0");
  assert.equal(keyIdHex(parsePublicKey(TAURI_PUBKEY).keyId), "502C71651358215B");
});

test("refuses a changed file, another key, a changed trusted comment and broken formats", () => {
  const pk = parsePublicKey(TAURI_PUBKEY);
  assert.throws(() => verifyMinisign(Buffer.from("version: 9.9.9\n"), TAURI_SIG, pk), /does not match the file/);
  const other = minisignKeyPair();
  assert.throws(() => verifyMinisign(feed, TAURI_SIG, parsePublicKey(other.publicKeyFile)), /made with key 502C71651358215B, the app trusts/);
  assert.throws(() => verifyMinisign(feed, TAURI_SIG.replace("version:0.3.0", "version:0.4.0"), pk), /trusted comment is not signed/);
  assert.throws(() => verifyMinisign(feed, "", pk), MinisignError);
  assert.throws(() => verifyMinisign(feed, TAURI_SIG.split("\n").slice(0, 2).join("\n"), pk), /not a minisign signature file/);
  assert.throws(() => verifyMinisign(feed, TAURI_SIG.replace(/^RUR/m, "R!R"), pk), /not base64/);
  assert.throws(() => parsePublicKey("REPLACE_WITH_THE_OWNERS_MINISIGN_PUBLIC_KEY"), MinisignError);
  assert.throws(() => parsePublicKey(Buffer.from("not a key").toString("base64")), MinisignError);
});

test("prehashed and legacy signatures of a throwaway key; the key id must match", () => {
  const k = minisignKeyPair();
  const pk = parsePublicKey(k.publicKeyFile);
  assert.equal(verifyMinisign(feed, k.sign(feed), pk).fields.file, "latest-linux.yml");
  assert.equal(verifyMinisign(feed, k.sign(feed, { algorithm: "Ed" }), pk).fields.version, "0.3.0");
  assert.throws(() => verifyMinisign(feed, k.sign(feed, { keyId: randomBytes(8) }), pk), /made with key/);
  // A signature of the same bytes with the wrong algorithm byte (ED over the raw file) fails.
  const legacy = k.sign(feed, { algorithm: "Ed" }).split("\n");
  const raw = Buffer.from(legacy[1]!, "base64");
  raw.write("ED", 0, "latin1");
  legacy[1] = raw.toString("base64");
  assert.throws(() => verifyMinisign(feed, legacy.join("\n"), pk), /does not match the file/);
});
