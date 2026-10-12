// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys of the Windows app (docs/DESKTOP.md "Passkeys"): the shell runs the ceremony through the Windows WebAuthn
 * API (`passkey_create`, `passkey_get` in `src-tauri/src/passkey.rs`) with the web origin of the node the app is
 * connected to, because the webview's own origin can never be under the node's relying party id. The shell answers
 * with the credential as `PublicKeyCredential.toJSON()` and the PRF output apart (base64url); its error codes become
 * the DOMException names the client already explains (`describeError`).
 */
import { invoke } from "@tauri-apps/api/core";
import { b64urlDecode } from "@tavrn/sdk";
import type { NativePasskeyResult, PlatformPasskeys, WebauthnJson } from "./types";

/** The shell's answer (snake case). */
interface RawResult {
  credential: WebauthnJson;
  prf: string | null;
}

/** Shell error code → the name a browser's WebAuthn would throw. */
const ERROR_NAMES: Record<string, string> = {
  "passkey.cancelled": "NotAllowedError",
  "passkey.exists": "InvalidStateError",
  "passkey.refused": "SecurityError",
  "passkey.unavailable": "NotSupportedError",
};

/** A refused ceremony as the error a browser would throw (`passkey.failed` and unknown codes stay plain errors). */
export function passkeyError(e: unknown): Error {
  const code = typeof e === "string" ? e : e instanceof Error ? e.message : "passkey.failed";
  const error = new Error(code);
  error.name = ERROR_NAMES[code] ?? "Error";
  return error;
}

/** The shell's answer, checked: the PRF output must be 32 bytes, anything else counts as none. */
export function nativeResult(raw: RawResult): NativePasskeyResult {
  if (!raw || typeof raw.credential !== "object" || raw.credential === null || typeof raw.credential.id !== "string") throw passkeyError("passkey.failed");
  let prf: Uint8Array | null = null;
  if (typeof raw.prf === "string") {
    try {
      const bytes = b64urlDecode(raw.prf);
      prf = bytes.length === 32 ? bytes : null;
    } catch {
      prf = null;
    }
  }
  return { credential: raw.credential, prf };
}

type Call = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** The native ceremonies; `call` is the shell's IPC (tests pass a fake). */
export function nativePasskeys(call: Call = invoke): PlatformPasskeys {
  const run = (cmd: string, options: WebauthnJson) =>
    call(cmd, { options }).then(
      (raw) => nativeResult(raw as RawResult),
      (e: unknown) => {
        throw passkeyError(e);
      },
    );
  return {
    create: (options) => run("passkey_create", options),
    get: (options) => run("passkey_get", options),
  };
}
