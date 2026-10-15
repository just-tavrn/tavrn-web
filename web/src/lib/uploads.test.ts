// SPDX-License-Identifier: Apache-2.0
// The classification table itself (categories, executables, magic bytes) is the sdk's `classifyUpload` and
// `executableKind`, tested there against the protocol's test vectors; here: the web client's use of it.
import { UPLOAD_HEAD_BYTES, executableKind } from "@tavrn/sdk";
import { describe, expect, it } from "vitest";
import { acceptFor, classifyFile, isAllowed, readHead } from "./uploads";

const bytes = (...b: (number | string)[]) => new Uint8Array(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
const at = (offset: number, ...b: (number | string)[]) => {
  const tail = bytes(...b);
  const out = new Uint8Array(offset + tail.length);
  out.set(tail, offset);
  return out;
};
const file = (parts: BlobPart[], name: string, type = "") => new File(parts, name, { type });

describe("upload categories (PROTOCOL.md §7a)", () => {
  it("classifies a file by name, type and content with the sdk's rules", async () => {
    expect(await classifyFile(file(["x"], "photo.PNG"))).toEqual({ category: "images", executable: false });
    expect(await classifyFile(file(["x"], "notes", "text/plain"))).toEqual({ category: "documents", executable: false });
    expect(await classifyFile(file(["x"], "logo.svg", "image/svg+xml"))).toEqual({ category: "documents", executable: false });
    expect(await classifyFile(file(["x"], "level.sav", "application/octet-stream"))).toEqual({ category: "other", executable: false });
    expect(await classifyFile(file(["x"], "setup.exe"))).toEqual({ category: "other", executable: true });
    // The content counts: a program named like a photo, a disk image signature deep in the file.
    expect(await classifyFile(file([bytes("MZ", 0x90, 0)], "photo.png", "image/png"))).toEqual({ category: "other", executable: true });
    expect(await classifyFile(file([at(0x9001, "CD001"), new Uint8Array(1000)], "backup"))).toEqual({ category: "other", executable: true });
  });

  it("checks the policy and builds the picker filter", () => {
    expect(isAllowed({ category: "images", executable: false }, ["images"], false)).toBe(true);
    expect(isAllowed({ category: "documents", executable: false }, ["images"], false)).toBe(false);
    expect(isAllowed({ category: "other", executable: true }, ["other"], false)).toBe(false);
    expect(isAllowed({ category: "other", executable: true }, ["other"], true)).toBe(true);
    expect(acceptFor(["images", "other"])).toBe("");
    const accept = acceptFor(["images", "archives"]).split(",");
    expect(accept).toContain("image/*");
    expect(accept).toContain(".png");
    expect(accept).toContain(".zip");
    expect(accept).not.toContain("application/pdf");
    expect(acceptFor(["documents"]).split(",")).toEqual(expect.arrayContaining(["text/*", "application/pdf", ".pdf", ".svg"]));
  });

  it("reads enough of a blob for every magic number (disk images at 32 KiB)", async () => {
    const head = await readHead(new Blob([at(0x9001, "CD001"), new Uint8Array(100_000)]));
    expect(head.length).toBe(UPLOAD_HEAD_BYTES);
    expect(executableKind("disk", "", head)).toBe("disk_image");
    expect(await readHead(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
