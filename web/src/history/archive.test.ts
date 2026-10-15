// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { MemorySearchBackend, deriveSearchKeys, seal, type Decrypted, type SearchKeys } from "@tavrn/e2ee";
import type { Message } from "@tavrn/sdk";
import { HistoryArchive, fingerprint } from "./archive";

const C = "n.test/01CONV";
const ok = (body: string): Decrypted => ({ ok: true, content: { type: "text", body } });

/** Message `n` (ids sort like ULIDs), optionally in a thread, with a body of `pad` extra characters. */
function msg(n: number, over: Partial<Message> = {}): Message {
  return { id: `01M${String(n).padStart(6, "0")}`, conversation_id: "01CONV", author: "a@n.test", author_id: "U1", content: "ciphertext", created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), encrypted: true, epoch: 1, format: 1, mentions: [], mentions_everyone: false, ...over } as Message;
}

let archiveKeys: SearchKeys;

async function archive(backend = new MemorySearchBackend()) {
  archiveKeys = await deriveSearchKeys(crypto.getRandomValues(new Uint8Array(32)));
  return { backend, a: new HistoryArchive(backend, archiveKeys) };
}

describe("the device's archive of decrypted history (#4)", () => {
  let a: HistoryArchive;
  let backend: MemorySearchBackend;
  beforeEach(async () => {
    ({ a, backend } = await archive());
  });

  it("keeps messages with their decrypted content and pages them like the node: newest first, before, after, around", async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ message: msg(i), decrypted: ok(`m${i}`) }));
    await a.put(C, items, 50 * 1024 * 1024);
    const newest = await a.page(C, undefined, null, 50);
    expect(newest.map((m) => m.id)).toEqual(items.slice(70).reverse().map((i) => i.message.id));
    const older = await a.page(C, { before: newest.at(-1)!.id }, null, 50);
    expect(older[0]!.id).toBe(msg(69).id);
    expect(older).toHaveLength(50);
    const last = await a.page(C, { before: older.at(-1)!.id }, null, 50);
    expect(last).toHaveLength(20);
    // `after` pages come newest first as well (fetchPage reverses the node's answer).
    expect((await a.page(C, { after: msg(10).id }, null, 3)).map((m) => m.id)).toEqual([msg(13).id, msg(12).id, msg(11).id]);
    const around = await a.page(C, { around: msg(60).id }, null, 10);
    expect(around.map((m) => m.id)).toContain(msg(60).id);
    expect(around).toHaveLength(10);
    const contents = await a.decrypted(C, [msg(5), msg(6, { edited_at: "2026-01-02T00:00:00Z" })]);
    expect(contents.get(msg(5).id)).toEqual(ok("m5"));
    // An edit since then (another fingerprint): the archived content is stale and not used.
    expect(contents.has(msg(6).id)).toBe(false);
  });

  it("keeps channel and thread messages apart", async () => {
    await a.put(C, [{ message: msg(1), decrypted: ok("c") }, { message: msg(2, { thread_id: "T1" }), decrypted: ok("t") }, { message: msg(3), decrypted: ok("c2") }], 1e9);
    expect((await a.page(C, undefined, null, 50)).map((m) => m.id)).toEqual([msg(3).id, msg(1).id]);
    expect((await a.page(C, undefined, "T1", 50)).map((m) => m.id)).toEqual([msg(2).id]);
  });

  it("stays under the cap: the oldest messages go first; the usage figure follows", async () => {
    await a.put(C, Array.from({ length: 40 }, (_, i) => ({ message: msg(i), decrypted: ok("x".repeat(500)) })), 1e9);
    const full = await a.usage(C);
    expect(full).toBeGreaterThan(40 * 500);
    await a.enforce(C, Math.floor(full / 2));
    const half = await a.usage(C);
    expect(half).toBeLessThanOrEqual(Math.floor(full / 2));
    const kept = await a.page(C, undefined, null, 100);
    expect(kept[0]!.id).toBe(msg(39).id);
    expect(kept.length).toBeLessThan(40);
    expect(kept.at(-1)!.id > msg(0).id).toBe(true);
    // A new page over the cap evicts again.
    await a.put(C, [{ message: msg(40), decrypted: ok("x".repeat(500)) }], Math.floor(full / 2));
    expect(await a.usage(C)).toBeLessThanOrEqual(Math.floor(full / 2));
  });

  it("an edit replaces the entry; deletions and removal of the conversation clear it; other conversations stay", async () => {
    await a.put(C, [{ message: msg(1), decrypted: ok("old") }], 1e9);
    await a.put(C, [{ message: msg(1, { edited_at: "2026-02-01T00:00:00Z" }), decrypted: ok("new") }], 1e9);
    expect((await a.decrypted(C, [msg(1, { edited_at: "2026-02-01T00:00:00Z" })])).get(msg(1).id)).toEqual(ok("new"));
    expect(await a.page(C, undefined, null, 50)).toHaveLength(1);
    await a.put("n.test/OTHER", [{ message: msg(9), decrypted: ok("o") }], 1e9);
    await a.remove(C, [msg(1).id]);
    expect(await a.page(C, undefined, null, 50)).toEqual([]);
    await a.put(C, [{ message: msg(2), decrypted: ok("x") }], 1e9);
    await a.removeConversation(C);
    expect(await a.usage(C)).toBe(0);
    expect(await a.page("n.test/OTHER", undefined, null, 50)).toHaveLength(1);
    expect(await a.conversations()).toEqual(["n.test/OTHER"]);
  });

  it("stores nothing readable: no ids, conversation ids or text in the backend", async () => {
    await a.put(C, [{ message: msg(1), decrypted: ok("geheimer Text") }], 1e9);
    const dump = JSON.stringify([...(await backend.keys("docs")), ...(await backend.keys("meta"))]) + new TextDecoder().decode((await backend.getMany("docs", await backend.keys("docs")))[0]!);
    expect(dump).not.toMatch(/01CONV|01M000001|geheimer/);
    // Another key opens nothing.
    const other = new HistoryArchive(backend, await deriveSearchKeys(crypto.getRandomValues(new Uint8Array(32))));
    expect(await other.page(C, undefined, null, 50)).toEqual([]);
  });

  it("fingerprints a message by its author, device, epoch, edit and content", async () => {
    expect(await fingerprint(msg(1))).toBe(await fingerprint(msg(1)));
    for (const other of [{ edited_at: "x" }, { epoch: 2 }, { device_id: "D2" }, { author: "mallory@n.test" }, { content: "other ciphertext" }] as Partial<Message>[]) {
      expect(await fingerprint(msg(1, other)), JSON.stringify(other)).not.toBe(await fingerprint(msg(1)));
    }
  });

  it("never hands out archived content for the same id served with another author, device or content", async () => {
    await a.put(C, [{ message: msg(1, { device_id: "D1" }), decrypted: ok("alice's words") }], 1e9);
    expect((await a.decrypted(C, [msg(1, { device_id: "D1" })])).get(msg(1).id)).toEqual(ok("alice's words"));
    for (const other of [{ author: "mallory@n.test", author_id: "U9" }, { device_id: "D9" }, { content: "other ciphertext" }] as Partial<Message>[]) {
      const served = msg(1, { device_id: "D1", ...other });
      expect((await a.decrypted(C, [served])).has(served.id), JSON.stringify(other)).toBe(false);
    }
  });

  it("entries of the earlier format (edit, epoch and device only) are not used", async () => {
    const m = msg(1, { device_id: "D1" });
    const internals = a as unknown as { docKey(c: string, id: string): Promise<string> };
    await a.put(C, [{ message: m, decrypted: ok("x") }], 1e9);
    const key = await internals.docKey(C, m.id);
    const legacy = await seal(archiveKeys, `history\u0000${key}`, { m, d: ok("x"), f: `${m.edited_at ?? ""}|${m.epoch ?? ""}|${m.device_id ?? ""}` });
    await backend.write([{ store: "docs", key, value: legacy }]);
    expect((await a.decrypted(C, [m])).has(m.id)).toBe(false);
  });
});
