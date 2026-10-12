// SPDX-License-Identifier: Apache-2.0
/**
 * The update check's failures as Settings → App shows them. The shells (the Tauri shell's `updater.rs`, the Electron
 * shell's `updater.ts`, the Android check in `release.rs`) reject with one of these codes; the client turns the
 * rejection into an error with `problem.code`, so `describeError` shows `errors.update.<code>` instead of the generic
 * "Something went wrong". Anything else becomes `update.failed`.
 */

export const UPDATE_ERROR_CODES = [
  // The update server could not be reached (no network, or it has no release list right now).
  "update.unreachable",
  // The chosen channel has no release.
  "update.no_release",
  // The download is not signed with the app's update key.
  "update.signature_invalid",
  // Anything else.
  "update.failed",
  // The build carries no update key; the update was installed meanwhile; an unknown channel.
  "update.not_configured",
  "update.none",
  "update.channel_invalid",
] as const;

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

const KNOWN = new Set<string>(UPDATE_ERROR_CODES);

/** The code of a shell's rejection (`update.failed` for anything that is not one of the codes). */
export function updateErrorCode(e: unknown): UpdateErrorCode {
  const code = typeof e === "string" ? e : ((e as { problem?: { code?: unknown } } | null)?.problem?.code ?? null);
  return typeof code === "string" && KNOWN.has(code) ? (code as UpdateErrorCode) : "update.failed";
}

/** Rethrows a shell's rejection as an error Settings → App can name. */
export function updateFailure(e: unknown): never {
  const code = updateErrorCode(e);
  if (code === "update.failed" && e !== "update.failed") console.warn("update: the shell answered", e);
  throw Object.assign(new Error(code), { problem: { code } });
}
