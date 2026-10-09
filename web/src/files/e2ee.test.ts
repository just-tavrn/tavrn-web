// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { FileEntry } from "@tavrn/sdk";
import { decryptFileBytes, encryptedSize, type Decrypted, type FileRecordResult } from "@tavrn/e2ee";
import { createFolderEncrypted, decryptRecords, displayEntries, entryCategory, fileIndexEntries, filesLockState, loadEncrypted, numberedName, renameEncrypted, uniqueName, uploadEncrypted, type EncryptedContext, type FilesApi } from "./e2ee";

const entry = (id: string, kind: "file" | "folder", size: number, extra: Partial<FileEntry> = {}): FileEntry => ({
  id,
  channel_id: "C1",
  parent_id: null,
  kind,
  name: "",
  mime: "",
  size,
  sha256: "",
  created_by: "U1",
  created_at: "2026-10-09T10:00:00.000Z",
  updated_at: "2026-10-09T10:00:00.000Z",
  record: null,
  record_epoch: null,
  record_author: null,
  record_device_id: null,
  record_at: null,
  thumbnail_size: 0,
  ...extra,
});

/** A session manager stand-in: "encrypts" by keeping the JSON (the node only stores it), decrypts it back. */
function fakeMls() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    encrypt: async (_c: string, content: Record<string, unknown>) => {
      sent.push(content);
      return { content: btoa(JSON.stringify(content)), epoch: 4 };
    },
    decrypt: async (_c: string, m: { content: unknown }): Promise<Decrypted> => ({ ok: true, content: JSON.parse(atob(String(m.content))) as Record<string, unknown> }),
  };
}

/** A node stand-in for the files routes the client uses. */
function fakeApi() {
  const stored = new Map<string, { entry: FileEntry; bytes: Uint8Array; thumb?: Uint8Array }>();
  const api = {
    files: {
      uploadEncrypted: async (_r: string, _c: string, blob: Blob, req: { id: string; record: string; recordEpoch: number; category: string; parentId?: string | null }) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const e = entry(req.id, "file", bytes.length, { parent_id: req.parentId ?? null, record: req.record, record_epoch: req.recordEpoch, record_author: "alice@t.local", record_device_id: "D1" });
        stored.set(req.id, { entry: e, bytes });
        (api as unknown as { lastCategory: string }).lastCategory = req.category;
        return e;
      },
      createFolderEncrypted: async (_r: string, _c: string, req: { id: string; record: string; record_epoch: number; parent_id: string | null }) =>
        entry(req.id, "folder", 0, { record: req.record, record_epoch: req.record_epoch, record_author: "alice@t.local", record_device_id: "D1" }),
      update: async (_r: string, _c: string, id: string, req: { record?: string; record_epoch?: number }) => ({ ...stored.get(id)!.entry, ...req }),
      putThumbnail: async (_r: string, _c: string, id: string, ct: Uint8Array) => {
        stored.get(id)!.thumb = ct;
      },
      downloadResponse: async (_r: string, _c: string, id: string) => new Response(stored.get(id)!.bytes as Uint8Array<ArrayBuffer>),
    },
  };
  return { api: api as unknown as FilesApi, stored, raw: api as unknown as { lastCategory: string } };
}

describe("encrypted files channels in the client", () => {
  it("numbers duplicate names like the node does for unencrypted channels", () => {
    expect(numberedName("photo.jpg", 2)).toBe("photo (2).jpg");
    expect(numberedName("README", 3)).toBe("README (3)");
    expect(numberedName(".bashrc", 2)).toBe(".bashrc (2)");
    expect(uniqueName("Plan.pdf", ["plan.PDF", "Plan (2).pdf"])).toBe("Plan (3).pdf");
    expect(uniqueName("new.txt", ["old.txt"])).toBe("new.txt");
  });

  it("shows decrypted names, types and plaintext sizes, and locked entries with their own label", () => {
    const raw = [entry("A", "file", encryptedSize(10)), entry("B", "folder", 0), entry("C", "file", 99)];
    const results = new Map<string, FileRecordResult>([
      ["A", { ok: true, record: { entry: "A", kind: "file", name: "a.txt", mime: "text/plain", size: 10, key: "k" } }],
      ["B", { ok: false, reason: "missing_key" }],
      ["C", { ok: false, reason: "withheld" }],
    ]);
    const shown = displayEntries(raw, results, { file: "Encrypted file", folder: "Encrypted folder" });
    expect(shown.map((e) => [e.name, e.mime, e.size])).toEqual([
      ["a.txt", "text/plain", 10],
      ["Encrypted folder", "", 0],
      ["Encrypted file", "", 99],
    ]);
  });

  it("derives the lock state the message list uses", () => {
    const ok = new Map<string, FileRecordResult>([["A", { ok: true, record: { entry: "A", kind: "folder", name: "x", mime: "", size: 0, key: "" } }]]);
    expect(filesLockState("locked", ok)).toBe("locked");
    expect(filesLockState("no_group", ok)).toBe("no_group");
    expect(filesLockState("ready", ok)).toBeNull();
    expect(filesLockState("ready", new Map([["B", { ok: false, reason: "missing_key" }]]))).toBe("missing_keys");
    expect(filesLockState("ready", new Map([["B", { ok: false, reason: "bad_signature" }]]))).toBeNull();
  });

  it("uploads ciphertext with a record that names the entry, and reads the file back chunk by chunk", async () => {
    const { api, stored, raw } = fakeApi();
    const mls = fakeMls();
    const ctx: EncryptedContext = { api, mls, conversation: "t.local/C1", roomId: "R1", channelId: "C1" };
    const plain = new Uint8Array(3 * 1024 * 1024 + 5).map((_, i) => i % 7);
    const file = new File([plain], "  Report.pdf ", { type: "application/pdf" });
    const progress: number[] = [];
    const e = await uploadEncrypted(ctx, file, { parentId: "F1", name: file.name, onProgress: (p) => progress.push(p) });
    expect(raw.lastCategory).toBe("documents");
    expect(e.size).toBe(encryptedSize(plain.length));
    expect(mls.sent[0]).toMatchObject({ type: "files.entry", v: 1, entry: e.id, kind: "file", name: "Report.pdf", mime: "application/pdf", size: plain.length });
    expect(progress.length).toBeGreaterThan(1);
    // No plaintext reaches the node.
    expect(stored.get(e.id)!.bytes.subarray(0, 64)).not.toEqual(plain.subarray(0, 64));
    const results = await decryptRecords(mls, "t.local/C1", [stored.get(e.id)!.entry]);
    const r = results.get(e.id)!;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blob = await loadEncrypted(api, "R1", "C1", stored.get(e.id)!.entry, r.record);
    expect(blob.type).toBe("application/octet-stream");
    const back = new Uint8Array(await blob.arrayBuffer());
    expect(back.length).toBe(plain.length);
    expect(back.every((b, i) => b === plain[i])).toBe(true);
    // jsdom cannot draw: no thumbnail, and the record says so.
    expect(stored.get(e.id)!.thumb).toBeUndefined();
    void decryptFileBytes;
  });

  it("creates folders and renames with a new record that keeps the key", async () => {
    const { api, stored } = fakeApi();
    const mls = fakeMls();
    const ctx: EncryptedContext = { api, mls, conversation: "t.local/C1", roomId: "R1", channelId: "C1" };
    const folder = await createFolderEncrypted(ctx, "Board", null);
    expect(mls.sent[0]).toEqual({ type: "files.entry", v: 1, entry: folder.id, kind: "folder", name: "Board" });
    await expect(createFolderEncrypted(ctx, "a/b", null)).rejects.toThrow();
    const f = await uploadEncrypted(ctx, new File(["x"], "a.txt", { type: "text/plain" }), { parentId: null, name: "a.txt" });
    const before = mls.sent[1] as { key: string };
    const renamed = await renameEncrypted(ctx, f, { entry: f.id, kind: "file", name: "a.txt", mime: "text/plain", size: 1, key: before.key }, "b.txt");
    expect(mls.sent[2]).toMatchObject({ entry: f.id, name: "b.txt", key: before.key });
    expect(renamed.record_epoch).toBe(4);
    void stored;
  });

  it("indexes decrypted entries with name, folder path, category, size and uploader", () => {
    const e = entry("01J9ZK3G5M8Q2W4E6R8T0Y2VF1", "file", encryptedSize(1234), { parent_id: "P1" });
    const results = new Map<string, FileRecordResult>([[e.id, { ok: true, record: { entry: e.id, kind: "file", name: "beach.png", mime: "image/png", size: 1234, key: "k", thumbnail: { mime: "image/webp", width: 10, height: 10 } } }]]);
    const [doc] = fileIndexEntries("t.local/C1", "R1", [e, entry("X", "file", 50)], results, (p) => (p === "P1" ? "Trips/2026" : ""), () => "bob@t.local");
    expect(doc).toEqual({
      conversation: "t.local/C1",
      id: e.id,
      ts: Date.parse(e.created_at),
      author: "bob@t.local",
      text: "beach.png\nTrips/2026",
      files: [],
      room: "R1",
      file: { kind: "file", name: "beach.png", folder: "Trips/2026", mime: "image/png", category: "images", size: 1234, thumbnail: true, parent: "P1" },
    });
    expect(entryCategory({ kind: "file", mime: "application/zip", name: "a.zip" })).toBe("archives");
    expect(entryCategory({ kind: "file", mime: "image/svg+xml", name: "a.svg" })).toBe("documents");
    expect(entryCategory({ kind: "folder", mime: "", name: "x" })).toBe("");
  });
});
