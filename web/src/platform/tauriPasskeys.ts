// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys of the Windows app (docs/DESKTOP.md "Passkeys"): the shell runs the ceremony through the Windows WebAuthn
 * API (`passkey_create`, `passkey_get` in `src-tauri/src/passkey.rs`) with the web origin of the node the app is
 * connected to, because the webview's own origin can never be under the node's relying party id. The ceremony's rules
 * are transport-free in `nativePasskeys.ts` (the Linux app's Electron shell uses them over its bridge).
 */
import { invoke } from "@tauri-apps/api/core";
import { nativePasskeys as overCall, type PasskeyCall } from "./nativePasskeys";
import type { PlatformPasskeys } from "./types";

export { nativeResult, passkeyError } from "./nativePasskeys";

/** The native ceremonies over Tauri's IPC; `call` is replaced in tests. */
export function nativePasskeys(call: PasskeyCall = invoke): PlatformPasskeys {
  return overCall(call);
}
