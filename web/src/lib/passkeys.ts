// SPDX-License-Identifier: Apache-2.0
/**
 * Browser side of WebAuthn (PROTOCOL.md §5a.4): registration, second-factor and passkey-only login,
 * and evaluating the PRF for the secret storage (ENCRYPTION.md §2.4). The PRF output is returned to
 * the caller for local use only; the JSON sent to the node never contains it.
 */
import { secretStoragePrfInput } from "@tavrn/crypto";
import { b64urlDecode, credentialToJSON, parseCreationOptions, parseRequestOptions, prfEnabled, prfFirst, stripPrfResults, type AuthResponse, type TavrnApi, type WebauthnRegistered, type DeviceProof } from "@tavrn/sdk";
import { ensureCrypto } from "@tavrn/e2ee";

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials;
}

function cancelled(): Error {
  const e = new Error("The passkey ceremony was cancelled");
  e.name = "NotAllowedError";
  return e;
}

export interface RegisteredPasskey {
  registered: WebauthnRegistered;
  /** PRF output if the authenticator returned one at creation. */
  prf: Uint8Array | null;
  prfSupported: boolean;
}

/** Registers a passkey with `api` (session or pre-auth token in stage `enroll`). */
export async function registerPasskey(api: TavrnApi, name: string): Promise<RegisteredPasskey> {
  const { challenge_id, options } = await api.auth.webauthnRegisterStart();
  const cred = (await navigator.credentials.create(parseCreationOptions(options))) as PublicKeyCredential | null;
  if (!cred) throw cancelled();
  const prf = prfFirst(cred);
  const registered = await api.auth.webauthnRegisterFinish({ challenge_id, name, response: stripPrfResults(credentialToJSON(cred)) });
  return { registered, prf, prfSupported: registered.credential.prf_supported || prfEnabled(cred) };
}

export interface PasskeyLogin {
  session: AuthResponse;
  credentialId: string;
  prf: Uint8Array | null;
}

/** Second factor (with `preauthToken`) or passkey-only login (without); the PRF input rides along. */
export async function passkeyLogin(api: TavrnApi, opts: { preauthToken?: string; deviceName?: string; device?: DeviceProof | null } = {}): Promise<PasskeyLogin> {
  const { challenge_id, options } = await api.auth.webauthnLoginStart(opts.preauthToken ? { preauth_token: opts.preauthToken } : {});
  const cred = (await navigator.credentials.get(parseRequestOptions(options))) as PublicKeyCredential | null;
  if (!cred) throw cancelled();
  const prf = prfFirst(cred);
  const session = await api.auth.webauthnLoginFinish({
    challenge_id,
    response: stripPrfResults(credentialToJSON(cred)),
    preauth_token: opts.preauthToken ?? null,
    device_name: opts.deviceName ?? null,
    device: opts.device ?? null,
  });
  return { session, credentialId: cred.id, prf };
}

/**
 * Evaluates the secret storage PRF with one of `credentialIds` without involving the node (local
 * challenge; the result is only used to unwrap locally). Returns null if the authenticator has no PRF.
 */
export async function evaluatePrf(credentialIds: string[]): Promise<{ credentialId: string; prf: Uint8Array } | null> {
  await ensureCrypto();
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: credentialIds.map((id) => ({ type: "public-key" as const, id: b64urlDecode(id) })),
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: secretStoragePrfInput() } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw cancelled();
  const prf = prfFirst(cred);
  return prf ? { credentialId: cred.id, prf } : null;
}

/** Name proposed for a new passkey, from the platform. */
export function defaultPasskeyName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone/iPad";
  if (/Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Passkey";
}
