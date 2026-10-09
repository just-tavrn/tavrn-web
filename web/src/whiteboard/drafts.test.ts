// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { deriveSearchKeys } from "@tavrn/e2ee";
import { deleteDraft, draftName, legacyDraftName, readDraft, writeDraft, type DraftStore } from "./drafts";

const Q = "node.example/01J9ZK3G5M8Q2W4E6R8T0Y2V00";

function memoryStore(): DraftStore & { names: () => string[] } {
  const m = new Map<string, Uint8Array>();
  return {
    names: () => [...m.keys()],
    getSecret: async (n) => m.get(n) ?? null,
    putSecret: async (n, v) => void m.set(n, v),
    deleteSecret: async (n) => void m.delete(n),
  };
}

describe("whiteboard drafts in the local store", () => {
  it("names a draft by a keyed token, never by the conversation id", async () => {
    const keys = await deriveSearchKeys(new Uint8Array(32).fill(7));
    const name = await draftName(keys, Q);
    expect(name).toMatch(/^whiteboard-draft:[0-9a-f]{32}$/);
    expect(name).not.toContain("01J9ZK3G5M8Q2W4E6R8T0Y2V00");
    expect(await draftName(keys, Q)).toBe(name);
    expect(await draftName(keys, "node.example/01J9ZK3G5M8Q2W4E6R8T0Y2V01")).not.toBe(name);
    // Another device (another local key) gets other names.
    expect(await draftName(await deriveSearchKeys(new Uint8Array(32).fill(8)), Q)).not.toBe(name);
    const store = memoryStore();
    await writeDraft(store, keys, Q, new Uint8Array([1, 2]));
    expect(store.names()).toEqual([name]);
    expect(await readDraft(store, keys, Q)).toEqual(new Uint8Array([1, 2]));
    await deleteDraft(store, keys, Q);
    expect(store.names()).toEqual([]);
  });

  it("reads a draft under the old plaintext name once and moves it", async () => {
    const keys = await deriveSearchKeys(new Uint8Array(32).fill(7));
    const store = memoryStore();
    await store.putSecret(legacyDraftName(Q), new Uint8Array([9]));
    expect(await readDraft(store, keys, Q)).toEqual(new Uint8Array([9]));
    expect(store.names()).toEqual([await draftName(keys, Q)]);
    expect(await readDraft(store, keys, Q)).toEqual(new Uint8Array([9]));
    expect(await readDraft(memoryStore(), keys, Q)).toBeNull();
  });
});
