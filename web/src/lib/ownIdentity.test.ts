// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { IdentityKey, MasterSecret, signContinuity } from "@tavrn/crypto";
import { b64urlEncode } from "@tavrn/sdk";
import { IDENTITY_SEED, MemoryKeyStore, type ContinuityStatement } from "@tavrn/e2ee";
import { initCryptoForTests } from "../test/wasm";
import { ownIdentityChange } from "./ownIdentity";

beforeAll(() => initCryptoForTests());

const ADDRESS = "alice@t.local";

async function store() {
  const s = new MemoryKeyStore();
  const master = MasterSecret.generate();
  await s.saveMaster(ADDRESS, "01J9ZK3G5M8Q2W4E6R8T0Y2VA1", master.toBytes());
  return { s, derived: b64urlEncode(master.identityPublicKey()) };
}

describe("own identity.changed is judged against the key this device follows now", () => {
  it("a rotated account: the published current key is no reset (the generation 0 key differs)", async () => {
    const { s, derived } = await store();
    expect(await ownIdentityChange(s, { identity_public_key: derived })).toBe("same");
    // The account rotated its identity key (§9a): this device keeps the new seed.
    const k1 = IdentityKey.generate();
    const seed = new Uint8Array(32);
    await s.putSecret(IDENTITY_SEED, seed.fill(0));
    const rotated = IdentityKey.fromBytes(seed);
    expect(await ownIdentityChange(s, { identity_public_key: b64urlEncode(rotated.publicKey()) })).toBe("same");
    // Another rotation, signed by the key this device follows: followed, nothing wiped.
    const chain = [JSON.parse(signContinuity(rotated, k1, "2026-10-11T00:00:00Z")) as ContinuityStatement];
    expect(await ownIdentityChange(s, { identity_public_key: b64urlEncode(k1.publicKey()), continuity: chain })).toBe("rotated");
    // A key without a chain from this device's key: a reset elsewhere.
    expect(await ownIdentityChange(s, { identity_public_key: b64urlEncode(IdentityKey.generate().publicKey()) })).toBe("reset");
    expect(await ownIdentityChange(s, { identity_public_key: derived })).toBe("reset");
  });

  it("tells nothing while locked or without a published key", async () => {
    const { s, derived } = await store();
    expect(await ownIdentityChange(s, null)).toBe("unknown");
    s.lock();
    expect(await ownIdentityChange(s, { identity_public_key: derived })).toBe("unknown");
  });
});
