// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { sealToInbox } from "@tavrn/crypto";
import { b64urlDecode, b64urlEncode } from "@tavrn/sdk";
import { initCryptoForTests } from "../test/wasm";
import { SEALED_UNLOCK_MAX, UNLOCK_TYPE, createUnlockKeyPair, parseUnlockKey, sealUnlock, unlockFragment } from "./sealedUnlock";

beforeAll(() => initCryptoForTests());

const SESSION = "S".repeat(43);
const CRED = "Y3JlZC0x";
const prf = () => new Uint8Array(32).map((_, i) => i + 1);

describe("sealed unlock material (FEDERATION.md §8 step 3)", () => {
  it("round trip: the page seals to the app's public key, only the app opens it", () => {
    const keys = createUnlockKeyPair();
    const sealed = sealUnlock(keys.publicKey, { sessionId: SESSION, credentialId: CRED, prf: prf() });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    const opened = keys.open(sealed!, SESSION);
    expect(opened).toEqual({ credentialId: CRED, prf: prf() });

    // Another key pair (another handoff) cannot open it.
    const other = createUnlockKeyPair();
    expect(other.open(sealed!, SESSION)).toBeNull();
    // The box is bound to its session.
    expect(keys.open(sealed!, "T".repeat(43))).toBeNull();
    // A fresh ephemeral key per box.
    expect(sealUnlock(keys.publicKey, { sessionId: SESSION, credentialId: CRED, prf: prf() })).not.toBe(sealed);
    keys.dispose();
    other.dispose();
  });

  it("refuses tampered boxes and payloads of other kinds", () => {
    const keys = createUnlockKeyPair();
    const sealed = b64urlDecode(sealUnlock(keys.publicKey, { sessionId: SESSION, credentialId: CRED, prf: prf() })!);
    sealed[40]! ^= 1;
    expect(keys.open(b64urlEncode(sealed), SESSION)).toBeNull();
    expect(keys.open("not base64!", SESSION)).toBeNull();
    expect(keys.open("", SESSION)).toBeNull();

    const pk = b64urlDecode(keys.publicKey);
    const box = (payload: unknown) => b64urlEncode(sealToInbox(pk, new TextEncoder().encode(JSON.stringify(payload))));
    const good = { type: UNLOCK_TYPE, session_id: SESSION, credential_id: CRED, prf_output: b64urlEncode(prf()) };
    expect(keys.open(box(good), SESSION)).toEqual({ credentialId: CRED, prf: prf() });
    // A webhook payload sealed to the same key is not unlock material (domain separation by `type`).
    expect(keys.open(box({ content: { type: "text", body: "hi" } }), SESSION)).toBeNull();
    expect(keys.open(box({ ...good, type: "tavrn.connect.unlock.v2" }), SESSION)).toBeNull();
    expect(keys.open(box({ ...good, prf_output: b64urlEncode(new Uint8Array(31)) }), SESSION)).toBeNull();
    expect(keys.open(box({ ...good, credential_id: "a+b" }), SESSION)).toBeNull();
    expect(keys.open(box({ ...good, credential_id: "" }), SESSION)).toBeNull();
    expect(keys.open(box("just a string"), SESSION)).toBeNull();
    keys.dispose();
  });

  it("a disposed key pair opens nothing", () => {
    const keys = createUnlockKeyPair();
    expect(b64urlDecode(keys.publicKey)).toHaveLength(32);
    const sealed = sealUnlock(keys.publicKey, { sessionId: SESSION, credentialId: CRED, prf: prf() })!;
    keys.dispose();
    expect(keys.open(sealed, SESSION)).toBeNull();
  });

  it("does not seal for an invalid key or material over the protocol's 1 KiB", () => {
    expect(sealUnlock("short", { sessionId: SESSION, credentialId: CRED, prf: prf() })).toBeNull();
    expect(sealUnlock("A".repeat(43), { sessionId: SESSION, credentialId: CRED, prf: new Uint8Array(16) })).toBeNull();
    const keys = createUnlockKeyPair();
    const longId = "a".repeat(1364);
    expect(sealUnlock(keys.publicKey, { sessionId: SESSION, credentialId: longId, prf: prf() })).toBeNull();
    const fits = sealUnlock(keys.publicKey, { sessionId: SESSION, credentialId: "a".repeat(800), prf: prf() });
    expect(b64urlDecode(fits!).length).toBeLessThanOrEqual(SEALED_UNLOCK_MAX);
    keys.dispose();
  });

  it("parses the key from the URL fragment", () => {
    const keys = createUnlockKeyPair();
    expect(unlockFragment(keys.publicKey)).toBe(`k=${keys.publicKey}`);
    expect(parseUnlockKey(`#k=${keys.publicKey}`)).toBe(keys.publicKey);
    expect(parseUnlockKey(`#x=1&k=${keys.publicKey}`)).toBe(keys.publicKey);
    expect(parseUnlockKey("")).toBeNull();
    expect(parseUnlockKey("#")).toBeNull();
    expect(parseUnlockKey("#k=")).toBeNull();
    expect(parseUnlockKey(`#k=${"A".repeat(42)}`)).toBeNull();
    expect(parseUnlockKey(`#k=${"A".repeat(44)}`)).toBeNull();
    expect(parseUnlockKey(`#k=${"+".repeat(43)}`)).toBeNull();
    keys.dispose();
  });
});
