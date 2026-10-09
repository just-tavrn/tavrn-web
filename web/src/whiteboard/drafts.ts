// SPDX-License-Identifier: Apache-2.0
/**
 * The owner's unsaved board per conversation in the local encrypted store. The store encrypts the values, but its
 * record names are plaintext: a name with the conversation id would tell anyone with the browser profile which
 * conversations have a board. The name is therefore an HMAC of the conversation under the device's search key
 * (`whiteboard-draft:<token>`, the same keyed token as the local search index). A draft under the old plaintext name
 * (`whiteboard-draft:<conversation>`) is read once as a fallback and moved to the new name.
 */
import { tokenKey, type SearchKeys } from "@tavrn/e2ee";

export interface DraftStore {
  getSecret(name: string): Promise<Uint8Array | null>;
  putSecret(name: string, value: Uint8Array): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

const PREFIX = "whiteboard-draft:";
/** The name before the HMAC (read once, then migrated). */
export const legacyDraftName = (q: string) => `${PREFIX}${q}`;

/** The record name of the draft of conversation `q` (qualified id). */
export async function draftName(keys: SearchKeys, q: string): Promise<string> {
  return `${PREFIX}${await tokenKey(keys, "whiteboard-draft", q)}`;
}

/** The draft's bytes, migrating a draft under the old plaintext name (it is deleted there). */
export async function readDraft(store: DraftStore, keys: SearchKeys, q: string): Promise<Uint8Array | null> {
  const name = await draftName(keys, q);
  const current = await store.getSecret(name);
  if (current) return current;
  const legacy = await store.getSecret(legacyDraftName(q));
  if (!legacy) return null;
  await store.putSecret(name, legacy);
  await store.deleteSecret(legacyDraftName(q));
  return legacy;
}

export async function writeDraft(store: DraftStore, keys: SearchKeys, q: string, bytes: Uint8Array): Promise<void> {
  await store.putSecret(await draftName(keys, q), bytes);
}

/** Deletes the draft under both names. */
export async function deleteDraft(store: DraftStore, keys: SearchKeys, q: string): Promise<void> {
  await store.deleteSecret(await draftName(keys, q));
  await store.deleteSecret(legacyDraftName(q));
}
