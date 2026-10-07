// SPDX-License-Identifier: Apache-2.0
/**
 * What happens to a picked file before it is uploaded (design note 4.13 item 6): image metadata is removed per
 * the user's setting (always / ask when found / never), HEIF/AVIF only get a note, and videos with location
 * data always ask "upload anyway / cancel". Runs before the upload (and so before E2EE encryption).
 */
import { inspectMetadata, stripImageMetadata } from "./metadata";
import type { MetadataMode } from "../stores/contentPrivacy";

export type UploadQuestion = { kind: "metadata"; found: string[] } | { kind: "video_location" };

export interface PreparedUpload {
  file: File;
  /** Shown on the pending upload: metadata was removed, or could not be (HEIF/AVIF). */
  note?: "removed" | "not_removed";
}

/**
 * The file to upload, or `null` when the user cancelled. `ask` answers `true` for "remove" (metadata) and
 * "upload anyway" (video location).
 */
export async function prepareUpload(file: File, mode: MetadataMode, ask: (q: UploadQuestion) => Promise<boolean>): Promise<PreparedUpload | null> {
  const first = mode === "always" ? await stripImageMetadata(file) : await inspectMetadata(file);
  if (first.warnings.includes("video_location") && !(await ask({ kind: "video_location" }))) return null;
  if (mode !== "never" && first.warnings.includes("heif_not_stripped")) return { file, note: "not_removed" };
  if (mode === "always") return first.file !== file ? { file: first.file, note: "removed" } : { file };
  if (mode === "never" || first.removed.length === 0) return { file };
  if (!(await ask({ kind: "metadata", found: first.removed }))) return { file };
  const stripped = await stripImageMetadata(file);
  return stripped.file !== file ? { file: stripped.file, note: "removed" } : { file };
}
