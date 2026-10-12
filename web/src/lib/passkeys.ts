// SPDX-License-Identifier: Apache-2.0
/**
 * Browser side of WebAuthn (PROTOCOL.md §5a.4): registration, second-factor and passkey-only login,
 * and evaluating the PRF for the secret storage (ENCRYPTION.md §2.4). The PRF output is returned to
 * the caller for local use only; the JSON sent to the node never contains it. The ceremonies run in the
 * browser (`navigator.credentials`), or natively in the apps (`platform().passkeys`: Windows, Android, and the Linux
 * app with a security key).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { secretStoragePrfInput } from "@tavrn/crypto";
import { b64urlDecode, b64urlEncode, credentialToJSON, parseCreationOptions, parseRequestOptions, prfEnabled, prfFirst, stripPrfResults, type AuthResponse, type ReauthToken, type TavrnApi, type WebauthnRegistered, type DeviceProof } from "@tavrn/sdk";
import { ensureCrypto } from "@tavrn/e2ee";
import { platform, type Platform } from "../platform";
import type { SecurityKeys, WebauthnJson } from "../platform/types";
import { publicApi } from "./api";

/** What the home node publishes about its relying party (`webauthn` of `GET /node`, PROTOCOL.md §5a.4). */
export interface NodeWebauthn {
  /** The relying party id, or null (an older node, or the request failed). */
  rpId: string | null;
  /** Every origin the node accepts (web origin first, then its apps' origins), or null when unknown. */
  origins: string[] | null;
}

/** The node's `webauthn` object, checked: anything malformed counts as absent. */
export function parseNodeWebauthn(raw: unknown): NodeWebauthn {
  const w = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rpId = typeof w.rp_id === "string" && w.rp_id ? w.rp_id : null;
  const origins = Array.isArray(w.origins) && w.origins.every((o) => typeof o === "string") ? (w.origins as string[]) : null;
  return { rpId, origins };
}

/** The home node's accepted origins once known, for the synchronous checks; components use {@link usePasskeySupport}. */
export const useNodeWebauthn = create<NodeWebauthn & { loaded: boolean; answered: boolean }>(() => ({ rpId: null, origins: null, loaded: false, answered: false }));

let nodeWebauthnPromise: Promise<NodeWebauthn> | null = null;

/**
 * The home node's relying party id and accepted origins, asked once per page. A failed request (or an older node
 * without the fields) is asked again next time.
 */
export function loadNodeWebauthn(): Promise<NodeWebauthn> {
  nodeWebauthnPromise ??= publicApi.node
    .info()
    .then((info) => ({ ...parseNodeWebauthn((info as { webauthn?: unknown }).webauthn), answered: true }))
    .catch(() => ({ rpId: null, origins: null, answered: false }))
    .then(({ answered, ...found }) => {
      if (!found.rpId) nodeWebauthnPromise = null;
      useNodeWebauthn.setState({ ...found, loaded: true, answered });
      return found;
    });
  return nodeWebauthnPromise;
}

/** Tests: forget what the node published (and the security keys seen). */
export function resetNodeWebauthn(): void {
  nodeWebauthnPromise = null;
  useNodeWebauthn.setState({ rpId: null, origins: null, loaded: false, answered: false });
  useSecurityKeys.setState({ keys: null });
}

/** The security keys plugged in, for the Linux app (null until the shell answered). */
export const useSecurityKeys = create<{ keys: SecurityKeys | null }>(() => ({ keys: null }));

/** Asks the shell for the security keys plugged in now (the Linux app; elsewhere nothing happens). */
export async function refreshSecurityKeys(p: Platform = platform()): Promise<SecurityKeys | null> {
  const ask = p.passkeys?.securityKeys;
  if (!ask) return null;
  const keys = await ask().catch(() => null);
  const old = useSecurityKeys.getState().keys;
  if (keys?.present !== old?.present || keys?.usable !== old?.usable) useSecurityKeys.setState({ keys });
  return keys;
}

/**
 * Why passkeys cannot run here, or null when they can:
 * - `platform`: no passkeys here (Android below 14, a browser without WebAuthn, an app without a native path);
 * - `pending`: the Android app does not know yet whether the node accepts its origin;
 * - `node`: the Android app could, but the node does not list the app's origin in `webauthn.origins`;
 * - `key`: the Linux app runs passkeys on a FIDO2 security key only, and none is plugged in;
 * - `key_access`: a security key is plugged in, but this system does not let the app open it (udev).
 * In each case the apps sign in with a passkey on the node's page in the browser (the connect flow).
 */
export type PasskeyBlocker = "platform" | "pending" | "node" | "key" | "key_access";

/**
 * Passkeys in the Windows app run natively (`p.passkeys`), in the Linux app natively with a security key plugged in
 * (`p.passkeys.securityKeys`, docs/DESKTOP.md "Passkeys on Linux"); the other desktop shells have none. The Android app
 * runs them through Android's Credential Manager (Android 14+), which signs with the app's origin: only while the home
 * node accepts that origin (docs/ANDROID.md "Passkeys"). Browsers need `navigator.credentials`.
 */
export function passkeyBlocker(
  p: Platform = platform(),
  origins: readonly string[] | null = useNodeWebauthn.getState().origins,
  keys: SecurityKeys | null = useSecurityKeys.getState().keys,
): PasskeyBlocker | null {
  if (p.android) {
    if (!p.passkeys || !p.android.origin) return "platform";
    if (!origins) return "pending";
    return origins.includes(p.android.origin) ? null : "node";
  }
  if (p.passkeys?.securityKeys) {
    if (!keys?.present) return "key";
    return keys.usable ? null : "key_access";
  }
  if (p.passkeys) return null;
  if (p.isDesktop) return "platform";
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined" && !!navigator.credentials ? null : "platform";
}

/** Passkeys can run here (see {@link passkeyBlocker}). */
export function passkeysSupported(p: Platform = platform(), origins: readonly string[] | null = useNodeWebauthn.getState().origins): boolean {
  return passkeyBlocker(p, origins) === null;
}

/** How often a mounted passkey view of the Linux app looks for a security key (it also looks when the window gets the focus). */
export const SECURITY_KEY_POLL_MS = 2_000;

/**
 * {@link passkeyBlocker} for components: asks the node in the Android app, and in the Linux app looks for a security
 * key while `active` (every {@link SECURITY_KEY_POLL_MS} and on focus), rendering again with the answers.
 */
export function usePasskeyBlocker(active = true): PasskeyBlocker | null {
  const origins = useNodeWebauthn((s) => s.origins);
  const loaded = useNodeWebauthn((s) => s.loaded);
  const answered = useNodeWebauthn((s) => s.answered);
  const keys = useSecurityKeys((s) => s.keys);
  const p = platform();
  const asks = !!p.android && !!p.passkeys && !!p.android.origin;
  useEffect(() => {
    if (asks) void loadNodeWebauthn();
  }, [asks]);
  const looksForKeys = active && !!p.passkeys?.securityKeys;
  useEffect(() => {
    if (!looksForKeys) return;
    const look = () => void refreshSecurityKeys(p);
    look();
    const timer = setInterval(look, SECURITY_KEY_POLL_MS);
    window.addEventListener("focus", look);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", look);
    };
  }, [looksForKeys, p]);
  const blocker = passkeyBlocker(p, origins, keys);
  if (blocker !== "pending" || !loaded) return blocker;
  // An older node without the list does not accept the app; an unreachable one: the browser as before, no reason.
  return answered ? "node" : "platform";
}

function cancelled(): Error {
  const e = new Error("The passkey ceremony was cancelled");
  e.name = "NotAllowedError";
  return e;
}

/** A ceremony's result: the credential JSON for the node (without the PRF output) and the PRF output apart. */
interface Ceremony {
  json: WebauthnJson;
  id: string;
  prf: Uint8Array | null;
  prfEnabled: boolean;
}

/** `navigator.credentials.create`, or the apps' native registration. */
async function createCredential(options: WebauthnJson): Promise<Ceremony> {
  const native = platform().passkeys;
  if (native) {
    const r = await native.create(options);
    const ext = (r.credential.clientExtensionResults ?? {}) as { prf?: { enabled?: boolean } };
    return { json: stripPrfResults(r.credential), id: String(r.credential.id), prf: r.prf, prfEnabled: !!ext.prf?.enabled };
  }
  const cred = (await navigator.credentials.create(parseCreationOptions(options))) as PublicKeyCredential | null;
  if (!cred) throw cancelled();
  return { json: stripPrfResults(credentialToJSON(cred)), id: cred.id, prf: prfFirst(cred), prfEnabled: prfEnabled(cred) };
}

/** `navigator.credentials.get`, or the apps' native assertion. */
async function getAssertion(options: WebauthnJson): Promise<Ceremony> {
  const native = platform().passkeys;
  if (native) {
    const r = await native.get(options);
    return { json: stripPrfResults(r.credential), id: String(r.credential.id), prf: r.prf, prfEnabled: !!r.prf };
  }
  const cred = (await navigator.credentials.get(parseRequestOptions(options))) as PublicKeyCredential | null;
  if (!cred) throw cancelled();
  return { json: stripPrfResults(credentialToJSON(cred)), id: cred.id, prf: prfFirst(cred), prfEnabled: false };
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
  const cred = await createCredential(options as WebauthnJson);
  const registered = await api.auth.webauthnRegisterFinish({ challenge_id, name, response: cred.json });
  return { registered, prf: cred.prf, prfSupported: registered.credential.prf_supported || cred.prfEnabled };
}

export interface PasskeyLogin {
  session: AuthResponse;
  credentialId: string;
  prf: Uint8Array | null;
}

/** Second factor (with `preauthToken`) or passkey-only login (without); the PRF input rides along. */
export async function passkeyLogin(api: TavrnApi, opts: { preauthToken?: string; deviceName?: string; device?: DeviceProof | null } = {}): Promise<PasskeyLogin> {
  const { challenge_id, options } = await api.auth.webauthnLoginStart(opts.preauthToken ? { preauth_token: opts.preauthToken } : {});
  const cred = await getAssertion(options as WebauthnJson);
  const session = await api.auth.webauthnLoginFinish({
    challenge_id,
    response: cred.json,
    preauth_token: opts.preauthToken ?? null,
    device_name: opts.deviceName ?? null,
    device: opts.device ?? null,
  });
  return { session, credentialId: cred.id, prf: cred.prf };
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
  const cred = await getAssertion(options as WebauthnJson);
  try {
    const reauth = await api.auth.reauth({ challenge_id, response: cred.json });
    return { reauth, credentialId: cred.id, prf: cred.prf };
  } catch (e) {
    cred.prf?.fill(0);
    throw e;
  }
}

/**
 * The WebAuthn relying party id this node publishes (`webauthn.rp_id`, PROTOCOL.md §5a.4): with delegation a
 * parent domain of the page's host, which the browser would not use by itself.
 */
async function relyingPartyId(): Promise<string | null> {
  return (await loadNodeWebauthn()).rpId;
}

/**
 * Evaluates the secret storage PRF with one of `credentialIds` without involving the node (local
 * challenge; the result is only used to unwrap locally). Returns null if the authenticator has no PRF.
 * The assertion names the node's relying party id (the node's own ceremonies carry it in their options).
 */
export async function evaluatePrf(credentialIds: string[]): Promise<{ credentialId: string; prf: Uint8Array } | null> {
  await ensureCrypto();
  const rpId = await relyingPartyId();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const native = platform().passkeys;
  if (native) {
    const cred = await getAssertion({
      publicKey: {
        ...(rpId ? { rpId } : {}),
        challenge: b64urlEncode(challenge),
        allowCredentials: credentialIds.map((id) => ({ type: "public-key", id })),
        userVerification: "required",
        timeout: 120_000,
        extensions: { prf: { eval: { first: b64urlEncode(secretStoragePrfInput()) } } },
      },
    });
    return cred.prf ? { credentialId: cred.id, prf: cred.prf } : null;
  }
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...(rpId ? { rpId } : {}),
      challenge,
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
