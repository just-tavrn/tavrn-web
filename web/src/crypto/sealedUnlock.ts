// SPDX-License-Identifier: Apache-2.0
/**
 * Sealed unlock material of the connect flow's app sessions (FEDERATION.md §8 step 3, "Sealed unlock material").
 *
 * A passkey ceremony on the home node's page yields the PRF output that unlocks the master secret (ENCRYPTION.md
 * §2.4), but the master secret is needed in the desktop app. The app creates an X25519 key pair per handoff and puts
 * the public key into the page's URL fragment (`#k=`); the page seals `{ type, session_id, credential_id,
 * prf_output }` to it and sends the box with its confirmation; the app opens it.
 *
 * The box is libsodium's `crypto_box_seal`, the construction of the webhook inbox (ENCRYPTION.md §5b), through the
 * functions `@tavrn/crypto` already has: the page seals with `sealToInbox`; the app's key pair is the inbox pair of a
 * random 32-byte seed (`inboxPublicKey`), opened with `Client.openSealed` of a throwaway client that holds the seed as
 * the "content key" of a placeholder conversation. No new cryptography: a seed from the system RNG, one HKDF step to
 * the X25519 secret, the sealed box. `type` separates this payload from every other sealed payload, `session_id`
 * binds it to its handoff (a sealed box has no associated data).
 */
import { Client, inboxPublicKey, sealToInbox } from "@tavrn/crypto";
import { ensureCrypto } from "@tavrn/e2ee";
import { b64urlDecode, b64urlEncode } from "@tavrn/sdk";

/** The `type` of the sealed payload. */
export const UNLOCK_TYPE = "tavrn.connect.unlock.v1";
/** The node accepts at most 1 KiB of sealed material (decoded). */
export const SEALED_UNLOCK_MAX = 1024;

/** What the page hands to the app: the passkey's credential id and the PRF output of its ceremony. */
export interface UnlockMaterial {
  credentialId: string;
  prf: Uint8Array;
}

/** The app's key pair of one handoff: the public key for the fragment, `open` for the answer of the poll. */
export interface UnlockKeyPair {
  /** base64url of the 32-byte X25519 public key. */
  publicKey: string;
  /** Opens sealed material for `sessionId`; null if it does not open or is not unlock material of that session. */
  open(sealed: string, sessionId: string): UnlockMaterial | null;
  /** Forgets the secret key (the handoff ended). */
  dispose(): void;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
/** A WebAuthn credential id as the secret storage names it (ENCRYPTION.md §2.4). */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1364}$/;
/** Placeholders for the throwaway client that opens the box (never sent anywhere). */
const OPENER_ADDRESS = "unlock@app.invalid";
const OPENER_ID = "00000000000000000000000000";
const OPENER_CONVERSATION = `app.invalid/${OPENER_ID}`;

function decode(s: string): Uint8Array | null {
  if (!B64URL.test(s)) return null;
  try {
    return b64urlDecode(s);
  } catch {
    return null;
  }
}

/** A fresh key pair for one handoff (needs the initialized crypto module, `ensureCrypto`). */
export function createUnlockKeyPair(): UnlockKeyPair {
  let seed: Uint8Array | null = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = b64urlEncode(inboxPublicKey(seed));
  return {
    publicKey,
    open(sealed, sessionId) {
      const box = decode(sealed);
      if (!seed || !box || box.length > SEALED_UNLOCK_MAX) return null;
      let opener: Client | null = null;
      try {
        opener = Client.create(OPENER_ADDRESS, OPENER_ID);
        opener.importEpochKey(OPENER_CONVERSATION, 0, seed);
        return material(JSON.parse(opener.openSealed(OPENER_CONVERSATION, 0, box)), sessionId);
      } catch {
        return null;
      } finally {
        opener?.free();
      }
    },
    dispose() {
      seed?.fill(0);
      seed = null;
    },
  };
}

function material(payload: unknown, sessionId: string): UnlockMaterial | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== UNLOCK_TYPE || p.session_id !== sessionId) return null;
  if (typeof p.credential_id !== "string" || !CREDENTIAL_ID.test(p.credential_id)) return null;
  const prf = typeof p.prf_output === "string" ? decode(p.prf_output) : null;
  if (!prf || prf.length !== 32) return null;
  return { credentialId: p.credential_id, prf };
}

/**
 * The page: seals `material` for the app session `sessionId` to the app's `publicKey` (base64url). Null when the key
 * is invalid or the box would exceed the node's limit (the app then falls back to the recovery key).
 */
export function sealUnlock(publicKey: string, material: UnlockMaterial & { sessionId: string }): string | null {
  const key = decode(publicKey);
  if (!key || key.length !== 32 || material.prf.length !== 32 || !CREDENTIAL_ID.test(material.credentialId)) return null;
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ type: UNLOCK_TYPE, session_id: material.sessionId, credential_id: material.credentialId, prf_output: b64urlEncode(material.prf) }),
  );
  try {
    const box = sealToInbox(key, plaintext);
    return box.length <= SEALED_UNLOCK_MAX ? b64urlEncode(box) : null;
  } catch {
    return null;
  } finally {
    plaintext.fill(0);
  }
}

/** {@link sealUnlock} after loading the crypto module; null when it cannot seal. */
export async function sealForApp(publicKey: string, material: UnlockMaterial & { sessionId: string }): Promise<string | null> {
  try {
    await ensureCrypto();
    return sealUnlock(publicKey, material);
  } catch {
    return null;
  }
}

/** The fragment the app appends to the page's URL: `k=<public key>`. */
export function unlockFragment(publicKey: string): string {
  return `k=${publicKey}`;
}

/** The app's public key from a URL fragment (`#k=…`, 43 characters of base64url = 32 bytes), or null. */
export function parseUnlockKey(hash: string): string | null {
  const k = new URLSearchParams(hash.replace(/^#/, "")).get("k");
  if (!k || !/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
  return decode(k)?.length === 32 ? k : null;
}
