// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MasterSecret, RecoveryKey, verifyDeviceAttestation, wrapMasterSecret } from "@tavrn/crypto";
import { TavrnApiError, b64urlDecode, b64urlEncode, type TavrnApi } from "@tavrn/sdk";
import { initCryptoForTests } from "../test/wasm";
import { cryptoStore } from "./store";
import {
  E2eeError,
  addPasskeySecret,
  ensureDevice,
  loadClient,
  localDeviceLost,
  localStatus,
  passkeyEntryIds,
  regenerateRecoveryKey,
  resetIdentity,
  setupAccount,
  unlockWithPasskeyPrf,
  unlockWithRecoveryKey,
  wipeLocal,
  forgetIdentityKeepDevice,
  localIdentityKey,
  type E2eeContext,
} from "./e2ee";

const DEV_A = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const DEV_B = "01J9ZK3G5M8Q2W4E6R8T0Y2VB1";
const CRED = "Y3JlZC0x";

function problem(status: number, code: string) {
  return new TavrnApiError({ type: "x", title: code, status, detail: "", code });
}

/** In-memory home node with the checks that matter for the client flows. */
function fakeNode(username: string) {
  const address = `${username}@t.local`;
  const state = {
    identity: null as string | null,
    entries: new Map<string, string>(),
    devices: new Map<string, { key: string; sig: string }>(),
    keyPackages: new Map<string, number>(),
    calls: [] as string[],
  };
  const api = {
    keys: {
      get: async (u: string) => {
        state.calls.push(`get ${u}`);
        // Attested devices, as the node lists them (ENCRYPTION.md §2.3).
        const devices = [...state.devices].map(([device_id, d]) => ({ device_id, device_public_key: d.key, identity_signature: d.sig, created_at: "" }));
        return { user: address, identity_public_key: state.identity, devices };
      },
      putIdentity: async ({ identity_public_key }: { identity_public_key: string }) => {
        state.calls.push("putIdentity");
        if (state.identity) throw problem(409, "e2ee.identity_exists");
        state.identity = identity_public_key;
      },
      resetIdentity: async ({ identity_public_key, password }: { identity_public_key: string; password: string }) => {
        if (password !== "pw") throw problem(401, "auth.invalid_credentials");
        state.identity = identity_public_key;
        state.entries.clear();
        state.devices.clear();
        state.keyPackages.clear();
      },
      putDeviceKey: async (deviceId: string, req: { device_public_key: string; identity_signature: string }) => {
        state.calls.push(`putDeviceKey ${deviceId}`);
        const ok = verifyDeviceAttestation(address, deviceId, b64urlDecode(req.device_public_key), b64urlDecode(req.identity_signature), b64urlDecode(state.identity!));
        if (!ok) throw problem(400, "e2ee.attestation_invalid");
        if (state.devices.has(deviceId)) throw problem(409, "e2ee.device_key_exists");
        state.devices.set(deviceId, { key: req.device_public_key, sig: req.identity_signature });
      },
      // The share key of a device attested earlier (ENCRYPTION.md §3.1).
      putShareKey: async (deviceId: string) => {
        state.calls.push(`putShareKey ${deviceId}`);
      },
      countKeyPackages: async (deviceId: string) => ({ count: state.keyPackages.get(deviceId) ?? 0 }),
      uploadKeyPackages: async (deviceId: string, req: { key_packages: string[] }) => {
        state.keyPackages.set(deviceId, (state.keyPackages.get(deviceId) ?? 0) + req.key_packages.length);
        return { count: state.keyPackages.get(deviceId) };
      },
    },
    secretStorage: {
      list: async () => ({ items: [...state.entries].map(([method, wrapped]) => ({ method, wrapped, params: {}, updated_at: "" })) }),
      putRecovery: async (req: { wrapped: string }) => {
        expect(b64urlDecode(req.wrapped)).toHaveLength(61);
        state.entries.set("recovery", req.wrapped);
      },
      putPasskey: async (id: string, req: { wrapped: string }) => void state.entries.set(`passkey:${id}`, req.wrapped),
    },
  } as unknown as TavrnApi;
  return { api, state, address };
}

let n = 0;
function account(deviceId = DEV_A) {
  const node = fakeNode(`user${++n}`);
  const ctx: E2eeContext = { api: node.api, username: `user${n}`, address: node.address, deviceId };
  return { ...node, ctx };
}

beforeAll(() => initCryptoForTests());
beforeEach(() => cryptoStore.lock());

describe("e2ee flows", () => {
  it("sets up a new account: identity, recovery entry, attested device, 20 KeyPackages, local master secret", async () => {
    const { ctx, state, address } = account();
    const recovery = RecoveryKey.generate();
    await setupAccount(ctx, recovery);
    expect(state.identity).toBeTruthy();
    expect(state.entries.has("recovery")).toBe(true);
    expect(state.devices.has(DEV_A)).toBe(true);
    expect(state.keyPackages.get(DEV_A)).toBe(20);
    expect(await localStatus(address, DEV_A)).toBe("unlocked");
    const master = MasterSecret.fromBytes(cryptoStore.masterSecret());
    expect(b64urlEncode(master.identityPublicKey())).toBe(state.identity);
    const client = (await loadClient())!;
    expect(b64urlEncode(client.devicePublicKey)).toBe(state.devices.get(DEV_A)!.key);
    expect(client.identity).toBe(`${address}/${DEV_A}`);
  });

  it("is idempotent: a retry reuses the local master secret and only tops up KeyPackages", async () => {
    const { ctx, state } = account();
    await setupAccount(ctx, RecoveryKey.generate());
    const identity = state.identity;
    await setupAccount(ctx, RecoveryKey.generate());
    expect(state.identity).toBe(identity);
    expect(state.keyPackages.get(DEV_A)).toBe(20);
    state.keyPackages.set(DEV_A, 3);
    await ensureDevice(ctx);
    expect(state.keyPackages.get(DEV_A)).toBe(20);
  });

  it("unlocks a new device with the recovery key words and attests it", async () => {
    const { ctx, state, address } = account();
    const recovery = RecoveryKey.generate();
    const words = recovery.toWords();
    await setupAccount(ctx, recovery);
    const original = cryptoStore.masterSecret();
    // Second browser: new session, new device id, nothing local.
    await wipeLocal(address);
    const ctxB = { ...ctx, deviceId: DEV_B };
    expect(await localStatus(address, DEV_B)).toBe("none");
    await expect(unlockWithRecoveryKey(ctxB, "not a key")).rejects.toMatchObject({ code: "recovery_key_invalid" });
    await expect(unlockWithRecoveryKey(ctxB, RecoveryKey.generate().toWords())).rejects.toMatchObject({ code: "recovery_key_wrong" });
    await unlockWithRecoveryKey(ctxB, `  ${words.toUpperCase()}  `);
    expect(cryptoStore.masterSecret()).toEqual(original);
    expect(state.devices.has(DEV_B)).toBe(true);
    expect(state.keyPackages.get(DEV_B)).toBe(20);
  });

  it("a session whose local store was lost: no second key for its device, the unlock reports device_key_lost (#83)", async () => {
    const { ctx, state, address } = account();
    const recovery = RecoveryKey.generate();
    await setupAccount(ctx, recovery);
    const attested = state.devices.get(DEV_A)!.key;
    // The app died before IndexedDB reached the disk; the session (localStorage) survived.
    await wipeLocal(address);
    expect(await localStatus(address, DEV_A)).toBe("none");
    expect(await localDeviceLost(ctx)).toBe(true);
    const err = await unlockWithRecoveryKey(ctx, recovery.toWords()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(E2eeError);
    expect((err as E2eeError).code).toBe("device_key_lost");
    expect(await loadClient()).toBeNull();
    expect(state.devices.get(DEV_A)!.key).toBe(attested);
    // Signed in again: a new device unlocks with the same recovery key.
    await wipeLocal(address);
    const fresh = { ...ctx, deviceId: DEV_B };
    expect(await localDeviceLost(fresh)).toBe(false);
    await unlockWithRecoveryKey(fresh, recovery.toWords());
    expect(b64urlEncode((await loadClient())!.devicePublicKey)).toBe(state.devices.get(DEV_B)!.key);
  });

  it("refuses a master secret whose identity key differs from the published one", async () => {
    const { ctx, state, address } = account();
    const recovery = RecoveryKey.generate();
    const compact = recovery.toCompact();
    await setupAccount(ctx, recovery);
    await wipeLocal(address);
    state.identity = b64urlEncode(MasterSecret.generate().identityPublicKey()); // stale or forged entry
    const err = await unlockWithRecoveryKey({ ...ctx, deviceId: DEV_B }, compact).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(E2eeError);
    expect((err as E2eeError).code).toBe("identity_mismatch");
    expect(cryptoStore.isUnlocked()).toBe(false);
  });

  it("unlocks a locked device (lock on close) without creating a new device", async () => {
    const { ctx, state, address } = account();
    const recovery = RecoveryKey.generate();
    const words = recovery.toWords();
    await setupAccount(ctx, recovery);
    await cryptoStore.setLockOnClose(true);
    const deviceKey = state.devices.get(DEV_A)!.key;
    cryptoStore.lock(); // tab closed
    expect(await localStatus(address, DEV_A)).toBe("locked");
    await unlockWithRecoveryKey(ctx, words);
    expect(cryptoStore.isUnlocked(address)).toBe(true);
    expect(b64urlEncode((await loadClient())!.devicePublicKey)).toBe(deviceKey);
    expect(state.calls.filter((c) => c === `putDeviceKey ${DEV_A}`)).toHaveLength(2); // second one answered "exists"
  });

  it("stores and uses a passkey PRF entry", async () => {
    const { ctx, address } = account();
    const prf = new Uint8Array(32).fill(5);
    await setupAccount(ctx, RecoveryKey.generate(), { credentialId: CRED, prf });
    expect(await passkeyEntryIds(ctx.api)).toEqual([CRED]);
    const original = cryptoStore.masterSecret();
    await wipeLocal(address);
    const ctxB = { ...ctx, deviceId: DEV_B };
    await expect(unlockWithPasskeyPrf(ctxB, CRED, new Uint8Array(32).fill(6))).rejects.toMatchObject({ code: "passkey_wrong" });
    await expect(unlockWithPasskeyPrf(ctxB, "b3RoZXI", prf)).rejects.toMatchObject({ code: "no_passkey_entry" });
    await unlockWithPasskeyPrf(ctxB, CRED, prf);
    expect(cryptoStore.masterSecret()).toEqual(original);
    // A passkey added later in the settings.
    await addPasskeySecret(ctxB, "Y3JlZC0y", new Uint8Array(32).fill(1));
    expect(await passkeyEntryIds(ctx.api)).toEqual([CRED, "Y3JlZC0y"]);
  });

  it("regenerating the recovery key re-wraps the same master secret", async () => {
    const { ctx, address } = account();
    const first = RecoveryKey.generate();
    const oldWords = first.toWords();
    await setupAccount(ctx, first);
    const original = cryptoStore.masterSecret();
    const second = RecoveryKey.generate();
    const newWords = second.toWords();
    await regenerateRecoveryKey(ctx, second);
    await wipeLocal(address);
    const ctxB = { ...ctx, deviceId: DEV_B };
    await expect(unlockWithRecoveryKey(ctxB, oldWords)).rejects.toMatchObject({ code: "recovery_key_wrong" });
    await unlockWithRecoveryKey(ctxB, newWords);
    expect(cryptoStore.masterSecret()).toEqual(original);
  });

  it("identity reset: new identity, keeps this device's key, re-attests, new recovery entry", async () => {
    const { ctx, state } = account();
    await setupAccount(ctx, RecoveryKey.generate());
    const oldIdentity = state.identity;
    const deviceKey = state.devices.get(DEV_A)!.key;
    const recovery = RecoveryKey.generate();
    await expect(resetIdentity(ctx, "wrong", recovery)).rejects.toMatchObject({ code: "auth.invalid_credentials" });
    await resetIdentity(ctx, "pw", recovery);
    expect(state.identity).not.toBe(oldIdentity);
    expect(state.devices.get(DEV_A)!.key).toBe(deviceKey);
    expect(state.entries.has("recovery")).toBe(true);
    expect(state.keyPackages.get(DEV_A)).toBe(20);
    expect(b64urlEncode(MasterSecret.fromBytes(cryptoStore.masterSecret()).identityPublicKey())).toBe(state.identity);
  });

  it("identity reset from a device without local data creates its device key", async () => {
    const { ctx, state, address } = account();
    await setupAccount(ctx, RecoveryKey.generate());
    await wipeLocal(address);
    const ctxB = { ...ctx, deviceId: DEV_B };
    await resetIdentity(ctxB, "pw", RecoveryKey.generate());
    expect(state.devices.has(DEV_B)).toBe(true);
    expect(state.devices.has(DEV_A)).toBe(false);
  });

  it("discards local data of another device id and wipes on logout", async () => {
    const { ctx, address } = account();
    await setupAccount(ctx, RecoveryKey.generate());
    cryptoStore.lock();
    expect(await localStatus(address, DEV_B)).toBe("none");
    await setupAccount(ctx, RecoveryKey.generate()).catch(() => {});
    await wipeLocal(address);
    expect(await localStatus(address, DEV_A)).toBe("none");
  });

  it("an identity reset on another device: forgets the master secret, keeps the device key, re-attests it after unlocking", async () => {
    const { ctx, state, address } = account();
    await setupAccount(ctx, RecoveryKey.generate());
    const deviceKey = state.devices.get(DEV_A)!.key;
    const oldIdentity = localIdentityKey();
    // Another device of the account resets the identity (ENCRYPTION.md §9).
    const fresh = MasterSecret.generate();
    const recovery = RecoveryKey.generate();
    state.identity = b64urlEncode(fresh.identityPublicKey());
    state.devices.clear();
    state.entries.set("recovery", b64urlEncode(wrapMasterSecret(fresh, recovery.wrappingKey(), address, "recovery")));
    await forgetIdentityKeepDevice(address);
    expect(await localStatus(address, DEV_A)).toBe("none");
    expect(localIdentityKey()).toBeNull();
    await unlockWithRecoveryKey(ctx, recovery.toWords());
    expect(localIdentityKey()).toBe(state.identity);
    expect(localIdentityKey()).not.toBe(oldIdentity);
    // Same device key, now attested under the new identity key.
    expect(state.devices.get(DEV_A)!.key).toBe(deviceKey);
    expect(b64urlEncode((await loadClient())!.devicePublicKey)).toBe(deviceKey);
  });
});
