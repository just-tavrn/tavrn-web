// SPDX-License-Identifier: Apache-2.0
/**
 * Upload categories (PROTOCOL.md §7a) in the web client. The classification itself is the sdk's (`classifyUpload`,
 * `executableKind`, `declaredCategory` of `@tavrn/sdk`): the node's table, pinned for every implementation by the
 * protocol's test vectors. This module reads a file's first bytes for it and applies an upload policy: the composer
 * filters the file picker and refuses files the user may not upload before sending anything; encrypted uploads
 * declare the category (`Tavrn-Upload-Category`), since the node only sees ciphertext.
 */
import { UPLOAD_CATEGORIES, UPLOAD_HEAD_BYTES, classifyUpload, extensionsOf, type ClassifiedUpload, type UploadCategoryName } from "@tavrn/sdk";
import { readBytes } from "./metadata";

/** The first {@link UPLOAD_HEAD_BYTES} of a file's content, for `classifyUpload` and `executableKind`. */
export async function readHead(data: Blob | Uint8Array): Promise<Uint8Array> {
  if (ArrayBuffer.isView(data)) return data.subarray(0, UPLOAD_HEAD_BYTES);
  return readBytes(data.slice(0, UPLOAD_HEAD_BYTES));
}

/** Classifies a file by its name, type and first bytes (by name and type alone when they cannot be read). */
export async function classifyFile(file: File): Promise<ClassifiedUpload> {
  let head: Uint8Array | undefined;
  try {
    head = await readHead(file);
  } catch {
    head = undefined;
  }
  return classifyUpload(file.name, file.type, head);
}

/** May this file be uploaded under the policy? */
export function isAllowed(c: ClassifiedUpload, allowed: readonly string[], executablesAllowed: boolean): boolean {
  if (c.executable && !executablesAllowed) return false;
  return allowed.includes(c.category);
}

/** `accept` attribute for a file input: empty (anything) when `other` is allowed. */
export function acceptFor(allowed: readonly string[]): string {
  if (allowed.includes("other")) return "";
  const parts: string[] = [];
  for (const cat of allowed) {
    if (cat === "images") parts.push("image/*");
    if (cat === "audio") parts.push("audio/*");
    if (cat === "video") parts.push("video/*");
    if (cat === "documents") parts.push("text/*", "application/pdf");
    if ((UPLOAD_CATEGORIES as readonly string[]).includes(cat)) parts.push(...extensionsOf(cat as UploadCategoryName).map((e) => `.${e}`));
  }
  return [...new Set(parts)].join(",");
}
