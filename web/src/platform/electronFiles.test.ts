// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { TavrnShellBridge } from "./electronBridge";
import { createElectronSaveFile } from "./electronFiles";
import { SAVE_CHUNK_BYTES } from "./files";

function fakeFiles() {
  const written: Uint8Array[] = [];
  const files = {
    saveFileBegin: vi.fn(async () => ({ status: "ready" as const, id: "7" })),
    saveFileChunk: vi.fn(async (_id: string, bytes: Uint8Array) => void written.push(bytes)),
    saveFileEnd: vi.fn(async () => ({ path: "/home/u/Downloads/plan.pdf", folder: "Downloads" })),
    saveFileAbort: vi.fn(async () => {}),
    saveFileReveal: vi.fn(async () => {}),
  } satisfies TavrnShellBridge["files"];
  return { files, written };
}

describe("createElectronSaveFile", () => {
  it("streams the content in 4 MiB pieces, in order, and reveals by the save's id", { timeout: 30_000 }, async () => {
    const { files, written } = fakeFiles();
    const data = new Uint8Array(2 * SAVE_CHUNK_BYTES + 3).map((_, i) => i & 0xff);
    const out = await createElectronSaveFile(files)({ name: "plan.pdf", data: new Blob([data], { type: "application/pdf" }) });
    expect(files.saveFileBegin).toHaveBeenCalledWith("plan.pdf", "application/pdf", data.byteLength);
    expect(written.map((w) => w.byteLength)).toEqual([SAVE_CHUNK_BYTES, SAVE_CHUNK_BYTES, 3]);
    expect(written.every((w) => w instanceof Uint8Array)).toBe(true);
    // Byte for byte, in order (compared by hand: a matcher over 8 MiB is slow).
    let at = 0;
    let same = true;
    for (const w of written) {
      for (let i = 0; i < w.byteLength; i++) same &&= w[i] === data[at + i];
      at += w.byteLength;
    }
    expect(same && at === data.byteLength).toBe(true);
    expect(out).toMatchObject({ status: "saved", name: "plan.pdf", path: "/home/u/Downloads/plan.pdf", folder: "Downloads" });
    if (out.status === "saved") await out.reveal?.();
    expect(files.saveFileReveal).toHaveBeenCalledWith("7");
  });

  it("names a type when the caller gives none and sends no piece for an empty file", async () => {
    const { files } = fakeFiles();
    await createElectronSaveFile(files)({ name: "empty", data: new Uint8Array(0) });
    expect(files.saveFileBegin).toHaveBeenCalledWith("empty", "application/octet-stream", 0);
    expect(files.saveFileChunk).not.toHaveBeenCalled();
    expect(files.saveFileEnd).toHaveBeenCalledWith("7");
  });

  it("a cancelled dialog writes nothing; a failed end aborts the save", async () => {
    const { files } = fakeFiles();
    files.saveFileBegin.mockResolvedValueOnce({ status: "cancelled" } as never);
    await expect(createElectronSaveFile(files)({ name: "a", data: new Uint8Array(1) })).resolves.toEqual({ status: "cancelled" });
    expect(files.saveFileChunk).not.toHaveBeenCalled();
    files.saveFileEnd.mockRejectedValueOnce("download.incomplete" as never);
    await expect(createElectronSaveFile(files)({ name: "a", data: new Uint8Array(1) })).rejects.toBe("download.incomplete");
    expect(files.saveFileAbort).toHaveBeenCalledWith("7");
  });
});
