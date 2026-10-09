// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { MemorySearchBackend, deriveSearchKeys, type Decrypted } from "@tavrn/e2ee";
import { TavrnApiError, type Message } from "@tavrn/sdk";
import { HistoryArchive } from "./archive";
import { HISTORY_CAP_CHOICES_MB, HISTORY_CAP_DEFAULT_MB, archiveMessages, archivedDecrypted, historyCapBytes, pageWithArchive, setHistoryCapMb } from "./local";

const Q = "n.test/01CONV";
const ok = (body: string): Decrypted => ({ ok: true, content: { type: "text", body } });
const msg = (n: number, over: Partial<Message> = {}) =>
  ({ id: `01M${String(n).padStart(6, "0")}`, conversation_id: "01CONV", author: "a@n.test", author_id: "U1", content: "ct", created_at: "2026-01-01T00:00:00Z", encrypted: true, epoch: 1, format: 1, mentions: [], mentions_everyone: false, ...over }) as Message;

describe("keeping the full history on this device: the client side (#4)", () => {
  let archive: HistoryArchive;
  let kept: Set<string>;
  const deps = () => ({ archive: async () => archive, kept: (q: string) => kept.has(q) });
  beforeEach(async () => {
    localStorage.clear();
    archive = new HistoryArchive(new MemorySearchBackend(), await deriveSearchKeys(crypto.getRandomValues(new Uint8Array(32))));
    kept = new Set([Q]);
  });

  it("archives only conversations with the setting; plaintext messages are kept without content", async () => {
    await archiveMessages("n.test/OTHER", [{ message: msg(1), decrypted: ok("x") }], deps());
    expect(await archive.conversations()).toEqual([]);
    await archiveMessages(Q, [{ message: msg(1), decrypted: ok("a") }, { message: msg(2, { encrypted: false, content: { type: "text", body: "plain" } }), decrypted: null }, { message: msg(3), decrypted: { ok: false, reason: "invalid" } as Decrypted }], deps());
    expect((await archive.page(Q, undefined, null, 50)).map((m) => m.id)).toEqual([msg(2).id, msg(1).id]);
    expect((await archivedDecrypted(Q, [msg(1)], deps())).get(msg(1).id)).toEqual(ok("a"));
    kept.clear();
    expect((await archivedDecrypted(Q, [msg(1)], deps())).size).toBe(0);
  });

  it("pages come from the node; while it cannot be reached, from the archive; the node's errors stay errors", async () => {
    await archiveMessages(Q, [{ message: msg(1), decrypted: ok("a") }, { message: msg(2), decrypted: ok("b") }], deps());
    const online = await pageWithArchive(Q, async () => [msg(9)], undefined, undefined, deps());
    expect(online.map((m) => m.id)).toEqual([msg(9).id]);
    const offline = await pageWithArchive(Q, () => Promise.reject(new TypeError("Failed to fetch")), undefined, undefined, deps());
    expect(offline.map((m) => m.id)).toEqual([msg(2).id, msg(1).id]);
    const older = await pageWithArchive(Q, () => Promise.reject(new TypeError("Failed to fetch")), { before: msg(2).id }, undefined, deps());
    expect(older.map((m) => m.id)).toEqual([msg(1).id]);
    // The API client reports an unreachable node as network.error; a gateway without the node answers 502 to 504.
    const network = new TavrnApiError({ type: "about:blank", title: "Network error", status: 0, detail: "Failed to fetch", code: "network.error" });
    expect((await pageWithArchive(Q, () => Promise.reject(network), undefined, undefined, deps())).length).toBe(2);
    const gateway = new TavrnApiError({ type: "x", title: "", status: 503, detail: "", code: "http.error" });
    expect((await pageWithArchive(Q, () => Promise.reject(gateway), undefined, undefined, deps())).length).toBe(2);
    const refused = new TavrnApiError({ type: "x", title: "", status: 403, detail: "", code: "permission.denied" });
    await expect(pageWithArchive(Q, () => Promise.reject(refused), undefined, undefined, deps())).rejects.toBe(refused);
    // Without the setting (or without archived messages) the network error stays.
    kept.clear();
    await expect(pageWithArchive(Q, () => Promise.reject(new TypeError("Failed to fetch")), undefined, undefined, deps())).rejects.toThrow("Failed to fetch");
  });

  it("the size cap per conversation: a sensible default, a few choices, kept on this device", () => {
    expect(HISTORY_CAP_DEFAULT_MB).toBe(50);
    expect(historyCapBytes()).toBe(50 * 1024 * 1024);
    expect(HISTORY_CAP_CHOICES_MB).toContain(HISTORY_CAP_DEFAULT_MB);
    setHistoryCapMb(250);
    expect(historyCapBytes()).toBe(250 * 1024 * 1024);
    setHistoryCapMb(7);
    expect(historyCapBytes()).toBe(250 * 1024 * 1024);
  });
});
