// SPDX-License-Identifier: Apache-2.0
/**
 * Account-level encryption flows of the web client (ENCRYPTION.md §2.4 client flows, §3, §8, §9). The
 * flows themselves live in `@tavrn/e2ee` (shared with bots); this module binds them to the browser's
 * IndexedDB store ({@link cryptoStore}) and keeps the passkey PRF output of a WebAuthn login ceremony
 * until it unlocked the account.
 */
import * as shared from "@tavrn/e2ee";
import type { Client, RecoveryKey } from "@tavrn/crypto";
import type { TavrnApi } from "@tavrn/sdk";
import { cryptoStore, type CryptoStatus } from "./store";

export { CLIENT_STATE, E2eeError, KEY_PACKAGE_BATCH, KEY_PACKAGE_MIN, passkeyEntryIds, type E2eeErrorCode } from "@tavrn/e2ee";

/** Context of the web flows: the shared context without the store (always {@link cryptoStore}). */
export interface E2eeContext {
  api: TavrnApi;
  /** Local username (path segment of `GET /users/{username}/keys`). */
  username: string;
  /** Full user address `username@domain`. */
  address: string;
  /** Device id of the current session. */
  deviceId: string;
}

const bind = (ctx: E2eeContext): shared.E2eeContext => ({ ...ctx, store: cryptoStore });

/** A passkey PRF output from a login ceremony, kept in memory only until it unlocked the account. */
let pendingPrf: { credentialId: string; prf: Uint8Array } | null = null;

export function rememberPrf(credentialId: string, prf: Uint8Array) {
  forgetPrf();
  pendingPrf = { credentialId, prf: prf.slice() };
}

export function takePrf(): { credentialId: string; prf: Uint8Array } | null {
  const p = pendingPrf;
  pendingPrf = null;
  return p;
}

export function forgetPrf() {
  pendingPrf?.prf.fill(0);
  pendingPrf = null;
}

/**
 * Status of this device for the account: resumes with the persisted local key if possible and
 * discards local data of an older device (another session in this browser).
 */
export function localStatus(address: string, deviceId: string | null, opts: { onStaleDevice?: (oldDeviceId: string) => void | Promise<void> } = {}): Promise<CryptoStatus> {
  return shared.localStatus(cryptoStore, address, deviceId, opts);
}

/**
 * Device proof for a login (PROTOCOL.md §5b): signs a nonce of `api`'s node with the key of the device this browser
 * holds for `address`, so the new session continues that device. Null (a new device follows) when there is none,
 * the store is locked (lock on close) or anything fails.
 */
export async function deviceProofFor(api: Pick<TavrnApi, "auth">, address: string | null): Promise<shared.LocalDeviceProof | null> {
  if (!address) return null;
  try {
    return await shared.deviceLoginProof(cryptoStore, address, async () => (await api.auth.deviceNonce()).nonce);
  } catch {
    return null;
  }
}

/** The MLS client of this device from the store (null if none was created yet). Requires an unlocked store. */
export function loadClient(): Promise<Client | null> {
  return shared.loadClient(cryptoStore);
}

/** Persists the client state; call after every mutating call on the client. */
export function saveClient(client: Client): Promise<void> {
  return shared.saveClient(cryptoStore, client);
}

/** Creates/attests this device and tops up KeyPackages (see `ensureDevice` in `@tavrn/e2ee`). */
export function ensureDevice(ctx: E2eeContext): Promise<void> {
  return shared.ensureDevice(bind(ctx));
}

/** Uploads the `passkey:<id>` entry for a PRF-capable credential (requires an unlocked store). */
export function addPasskeySecret(ctx: E2eeContext, credentialId: string, prf: Uint8Array): Promise<void> {
  return shared.addPasskeySecret(bind(ctx), credentialId, prf);
}

/** Registration (ENCRYPTION.md §2.4 flow 1), after the user confirmed `recovery`. */
export function setupAccount(ctx: E2eeContext, recovery: RecoveryKey, passkey?: { credentialId: string; prf: Uint8Array } | null): Promise<void> {
  return shared.setupAccount(bind(ctx), recovery, passkey);
}

/** Own `identity.changed` from another device: forget the master secret, keep the device key in memory. */
export function forgetIdentityKeepDevice(address: string): Promise<void> {
  return shared.forgetIdentityKeepDevice(cryptoStore, address);
}

/** The identity public key derived from the local master secret (base64url), or null if locked. */
export function localIdentityKey(): string | null {
  return shared.localIdentityKey(cryptoStore);
}

/** New device, cleared browser or lock on close: unlock with the 24 words, the compact string or the file. */
export function unlockWithRecoveryKey(ctx: E2eeContext, text: string): Promise<void> {
  return shared.unlockWithRecoveryKey(bind(ctx), text);
}

/** Unlock with the PRF output of a passkey ceremony (login or the unlock screen). */
export function unlockWithPasskeyPrf(ctx: E2eeContext, credentialId: string, prf: Uint8Array): Promise<void> {
  return shared.unlockWithPasskeyPrf(bind(ctx), credentialId, prf);
}

/** Settings: a new recovery key re-wraps the same master secret (ENCRYPTION.md §2.4 flow 3). */
export function regenerateRecoveryKey(ctx: E2eeContext, recovery: RecoveryKey): Promise<void> {
  return shared.regenerateRecoveryKey(bind(ctx), recovery);
}

/** Identity reset (ENCRYPTION.md §9) after the user confirmed the new recovery key. */
export function resetIdentity(ctx: E2eeContext, password: string, recovery: RecoveryKey): Promise<void> {
  return shared.resetIdentity(bind(ctx), password, recovery);
}

/**
 * Rotates the identity key with continuity (ENCRYPTION.md §9a). The node asks for a fresh confirmation
 * (`auth.reauth_required`, answered by the re-auth dialog of the API client).
 */
export function rotateIdentity(ctx: E2eeContext): Promise<{ identity_public_key: string; identity_generation: number }> {
  return shared.rotateIdentity({ api: ctx.api, username: ctx.username, address: ctx.address, store: cryptoStore });
}

/** Follows a rotation done on another device of the account (the key comes from the blob, ENCRYPTION.md §9a). */
export function syncIdentity(ctx: E2eeContext): Promise<"current" | "rotated"> {
  return shared.syncIdentity(ctx.api, cryptoStore, ctx.username, ctx.address);
}

/** Logout: delete the account's local crypto data and everything secret in memory. */
export async function wipeLocal(address: string): Promise<void> {
  forgetPrf();
  await shared.wipeLocal(cryptoStore, address);
}
