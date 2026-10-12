// SPDX-License-Identifier: Apache-2.0
/**
 * The errors of the Android app's biometric unlock (`unlock.ts`), apart from the shell's IPC so the key store
 * (`crypto/store.ts`) can tell them without loading anything of the shell in a browser.
 */
import type { UnlockErrorCode } from "./types";

const CODES: readonly UnlockErrorCode[] = ["cancelled", "lockout", "unavailable", "invalidated", "none", "busy", "invalid", "no_node", "failed"];

/** A refused or failed unlock call; `code` says why (`cancelled`: the user closed the prompt, nothing changed). */
export class UnlockError extends Error {
  override readonly name = "UnlockError";
  constructor(readonly code: UnlockErrorCode) {
    super(`unlock.${code}`);
  }
}

/** The code of a rejection: an {@link UnlockError}, or the shell's `unlock.<code>` string. */
export function unlockErrorCode(e: unknown): UnlockErrorCode {
  if (e instanceof UnlockError) return e.code;
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const code = text.startsWith("unlock.") ? (text.slice(7) as UnlockErrorCode) : null;
  return code && CODES.includes(code) ? code : "failed";
}

/** Rethrows any rejection as an {@link UnlockError}. */
export function asUnlockError(e: unknown): never {
  throw e instanceof UnlockError ? e : new UnlockError(unlockErrorCode(e));
}
