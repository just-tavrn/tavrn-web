// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import type { Decrypted } from "@tavrn/e2ee";
import { evidenceCandidates, selectedEvidence } from "./evidence";

const msg = (id: string, encrypted = true): Message =>
  ({ id, conversation_id: "C", author: `a${id}@n.example`, author_id: "u", device_id: `D${id}`, created_at: `2026-10-01T10:00:${id.padStart(2, "0")}Z`, encrypted, content: encrypted ? "cipher" : { type: "text", body: "plain" }, attachments: [], mentions: [], mentions_everyone: false, reactions: [], pinned: false }) as unknown as Message;
const ok = (body: string, extra: Record<string, unknown> = {}): Decrypted => ({ ok: true, content: { type: "text", body, ...extra } }) as unknown as Decrypted;

describe("evidence for reports of encrypted messages", () => {
  // Newest first, as the API delivers them: 14 is the newest.
  const messages = Array.from({ length: 15 }, (_, i) => msg(String(14 - i)));
  const decrypted: Record<string, Decrypted> = Object.fromEntries(messages.map((m) => [m.id, ok(`text ${m.id}`)]));

  it("takes the reported message and ten readable messages before it, oldest first", () => {
    const c = evidenceCandidates(messages, decrypted, "12");
    expect(c.map((e) => e.message_id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"].slice(1));
    expect(c.at(-1)).toMatchObject({ message_id: "12", reported: true, text: "text 12", author: "a12@n.example", device_id: "D12" });
    expect(c.filter((e) => e.reported)).toHaveLength(1);
  });

  it("skips unreadable messages, system content and plaintext", () => {
    const d = { ...decrypted, "11": { ok: false, reason: "no_key" } as unknown as Decrypted, "10": ok("", { type: "system.join" }) };
    const list = [msg("13"), msg("12"), msg("11"), msg("10"), msg("9", false), msg("8")];
    expect(evidenceCandidates(list, d, "12").map((e) => e.message_id)).toEqual(["8", "12"]);
    expect(evidenceCandidates(list, d, "11")).toEqual([]);
    expect(evidenceCandidates(list, d, "missing")).toEqual([]);
  });

  it("sends the reported message always and context messages only when selected", () => {
    const c = evidenceCandidates(messages, decrypted, "3");
    const sent = selectedEvidence(c, new Set(["1"]));
    expect(sent.map((e) => e.message_id)).toEqual(["1", "3"]);
    expect(sent[0]).not.toHaveProperty("reported");
    expect(selectedEvidence(c, new Set()).map((e) => e.message_id)).toEqual(["3"]);
  });

  it("caps text and keeps attachment names only", () => {
    const blob = { id: "01J00000000000000000000001", sha256: "A".repeat(43) };
    const d = { "1": ok("x".repeat(5000), { attachments: [{ ...blob, name: "photo.jpg", key: "B".repeat(43), nonce: "C".repeat(16), size: 1, mime: "image/jpeg" }] }) };
    const m = { ...msg("1"), attachments: [{ ...blob, size: 1 }] } as unknown as Message;
    const [e] = evidenceCandidates([m], d, "1");
    expect(e!.text).toHaveLength(4000);
    expect(e!.attachments).toEqual(["photo.jpg"]);
  });
});
