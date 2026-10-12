// SPDX-License-Identifier: Apache-2.0
/**
 * Unlock with fingerprint, face or PIN in the Android app (docs/ANDROID.md): the shell seals the local storage key of
 * the key store (`crypto/store.ts`) with a key of the Android Keystore that works only right after the system's prompt
 * (`android_unlock_*` in `src-tauri/src/android.rs`, `BiometricUnlock.kt`). This module wraps those commands and turns
 * their refusals into {@link UnlockError}s with a known code.
 */
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { PlatformUnlock, UnlockPromptTexts, UnlockStatus } from "./types";
import { UnlockError, asUnlockError } from "./unlockError";

export { UnlockError, unlockErrorCode } from "./unlockError";

/** The shell's IPC (tests pass a fake). */
export type UnlockCall = (cmd: string, args?: InvokeArgs) => Promise<unknown>;

export function createAndroidUnlock(call: UnlockCall = invoke): PlatformUnlock {
  return {
    status: async (account) => (await call("android_unlock_status", { account: account ?? null }).catch(asUnlockError)) as UnlockStatus,
    store: async (account: string, secret: Uint8Array, prompt: UnlockPromptTexts) => {
      await call("android_unlock_store", { account, secret: Array.from(secret), prompt }).catch(asUnlockError);
    },
    get: async (account, prompt) => {
      const secret = (await call("android_unlock_get", { account, prompt }).catch(asUnlockError)) as number[];
      if (!Array.isArray(secret) || secret.length !== 32) throw new UnlockError("failed");
      return new Uint8Array(secret);
    },
    clear: async (account) => {
      await call("android_unlock_clear", { account }).catch(asUnlockError);
    },
  };
}
