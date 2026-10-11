// SPDX-License-Identifier: Apache-2.0
/**
 * Own `identity.changed` (ENCRYPTION.md §9, §9a): what the key the home node publishes now means for this device.
 * Compared with the key this device follows now (rotated or derived), never with the generation 0 key derived from the
 * master secret: on a rotated account those always differ, and a spoofed event would wipe the master secret.
 */
import { chainReaches, ownIdentityPublicKey, type ContinuityStatement, type KeyStore } from "@tavrn/e2ee";

/**
 * `same`: this device follows the published key (it did the change itself); `rotated`: a rotation with a continuity
 * chain from this device's key (follow it); `reset`: another key without such a chain (an identity reset elsewhere:
 * this device starts over); `unknown`: nothing to compare (locked, no published key).
 */
export type OwnIdentityChange = "same" | "rotated" | "reset" | "unknown";

export async function ownIdentityChange(store: KeyStore, published: { identity_public_key?: string | null; continuity?: ContinuityStatement[] | null } | null): Promise<OwnIdentityChange> {
  const key = published?.identity_public_key ?? null;
  if (!key || !store.isUnlocked()) return "unknown";
  const own = await ownIdentityPublicKey(store).catch(() => null);
  if (!own) return "unknown";
  if (own === key) return "same";
  return chainReaches(published?.continuity, own, key) ? "rotated" : "reset";
}
