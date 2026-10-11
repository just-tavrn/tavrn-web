// SPDX-License-Identifier: Apache-2.0
/**
 * Browser side of WebAuthn (PROTOCOL.md §5a.4): registration, second-factor and passkey-only login,
 * and evaluating the PRF for the secret storage (ENCRYPTION.md §2.4). The PRF output is returned to
 * the caller for local use only; the JSON sent to the node never contains it.
 */
import { secretStoragePrfInput } from "@tavrn/crypto";
import { b64urlDecode, credentialToJSON, parseCreationOptions, parseRequestOptions, prfEnabled, prfFirst, stripPrfResults, type AuthResponse, type ReauthToken, type TavrnApi, type WebauthnRegistered, type DeviceProof } from "@tavrn/sdk";
import { ensureCrypto } from "@tavrn/e2ee";
import { platform } from "../platform";
import { publicApi } from "./api";

/** WebAuthn is there; never in the desktop app, whose origin is not the node's (passkeys are bound to the node's domain). */
export function passkeysSupported(): boolean {
  if (platform().isDesktop) return false;
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

export interface PasskeyReauth {
  reauth: ReauthToken;
  credentialId: string;
  /** PRF output of the same assertion (the node's options request it), or null without PRF. Local use only. */
  prf: Uint8Array | null;
}

/**
 * Re-authentication with a passkey (PROTOCOL.md §5c, `POST /auth/reauth`) whose assertion also evaluates the secret
 * storage PRF: one touch yields the reauth token and the PRF output. The response sent to the node never contains it.
 */
export async function passkeyReauth(api: TavrnApi): Promise<PasskeyReauth> {
  const { challenge_id, options } = await api.auth.reauthWebauthnStart();
  const cred = (await navigator.credentials.get(parseRequestOptions(options))) as PublicKeyCredential | null;
  if (!cred) throw cancelled();
  const prf = prfFirst(cred);
  try {
    const reauth = await api.auth.reauth({ challenge_id, response: stripPrfResults(credentialToJSON(cred)) });
    return { reauth, credentialId: cred.id, prf };
  } catch (e) {
    prf?.fill(0);
    throw e;
  }
}

let rpIdPromise: Promise<string | null> | null = null;

/**
 * The WebAuthn relying party id this node publishes (`webauthn.rp_id`, PROTOCOL.md §5a.4): with delegation a
 * parent domain of the page's host, which the browser would not use by itself. Asked once per page; an older node
 * without the field or a failed request gives null (the browser default) and is asked again next time.
 */
function relyingPartyId(): Promise<string | null> {
  rpIdPromise ??= publicApi.node
    .info()
    .then((info) => info.webauthn?.rp_id || null)
    .catch(() => null)
    .then((id) => {
      if (!id) rpIdPromise = null;
      return id;
    });
  return rpIdPromise;
}

/** Tests: forget the cached relying party id. */
export function resetRelyingPartyId(): void {
  rpIdPromise = null;
}

/**
 * Evaluates the secret storage PRF with one of `credentialIds` without involving the node (local
 * challenge; the result is only used to unwrap locally). Returns null if the authenticator has no PRF.
 * The assertion names the node's relying party id (the node's own ceremonies carry it in their options).
 */
export async function evaluatePrf(credentialIds: string[]): Promise<{ credentialId: string; prf: Uint8Array } | null> {
  await ensureCrypto();
  const rpId = await relyingPartyId();
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...(rpId ? { rpId } : {}),
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
