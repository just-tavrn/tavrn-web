// SPDX-License-Identifier: Apache-2.0
/**
 * Single sign-on via OpenID Connect (APPLICATIONS.md §8.2), the browser's part:
 *
 * 1. `startSso` creates a PKCE pair and a random `client_state`, remembers them for this tab and asks the
 *    node for the provider's authorization URL (`POST /auth/oidc/start`), then navigates there.
 * 2. The provider redirects to the node, the node to `/sso/callback?code&state` (or `?error&state`).
 * 3. `SsoCallbackPage` checks the state against this tab's pending flow and exchanges code and verifier
 *    (`POST /auth/oidc/token`) for a session (`login`), a link (`link`) or a reauth token (`reauth`).
 *
 * Only this origin's node is involved: SSO belongs to the account's home node.
 */
import { setReauth } from "../stores/reauth";
import { createPkce, randomUrlSafe, type TavrnApi } from "@tavrn/sdk";
import { safeNext } from "./remoteSignIn";
import { platform } from "../platform";
import { t } from "../i18n";

/** Single sign-on works only in the browser, on the node's own web client. */
export function ssoAvailable(): boolean {
  return !platform().isDesktop;
}

const PENDING_KEY = "tavrn.sso";
const LOGOUT_KEY = "tavrn.sso.logout";
/** A flow older than this is not completed (the node's state lives 10 minutes). */
export const SSO_MAX_AGE_MS = 10 * 60 * 1000;

export type SsoPurpose = "login" | "link" | "reauth";

export interface PendingSso {
  state: string;
  verifier: string;
  purpose: SsoPurpose;
  /** App path to continue with afterwards. */
  next: string;
  startedAt: number;
}

/** Starts a flow and leaves the page for the provider. `api` carries the session for `link`/`reauth`. */
export async function startSso(api: TavrnApi, purpose: SsoPurpose, next: string, navigate: (url: string) => void = (u) => location.assign(u)): Promise<void> {
  // The node sends the browser back to its own web client: the desktop app cannot receive the callback (docs/DESKTOP.md).
  if (!ssoAvailable()) throw new Error(t("desktop.sso_unavailable"));
  const { verifier, challenge } = await createPkce();
  const pending: PendingSso = { state: randomUrlSafe(), verifier, purpose, next: safeNext(next), startedAt: Date.now() };
  const resp = await api.oidc.start({ purpose, code_challenge: challenge, client_state: pending.state, device_name: "Browser" });
  const target = authorizationUrl(resp.authorization_url);
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  forgetSsoLogout();
  navigate(target);
}

/** The provider's authorization URL as the node names it: https only (plain http only to this machine, for development). */
function authorizationUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid authorization URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("the authorization URL must use https");
  return u.href;
}

/** Takes the pending flow of this tab (single use). */
export function takePendingSso(): PendingSso | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingSso) : null;
  } catch {
    return null;
  }
}

export type SsoCallbackCheck = { ok: true; code: string } | { ok: false; reason: "state" | "error"; error?: string };

/** Checks the callback parameters against the flow this tab started (state, age, error). */
export function checkSsoCallback(params: URLSearchParams, pending: PendingSso | null, now = Date.now()): SsoCallbackCheck {
  const error = params.get("error");
  if (!pending || params.get("state") !== pending.state || now - pending.startedAt > SSO_MAX_AGE_MS) {
    // An error without our state (e.g. `sso.state_invalid`) is still worth showing.
    return { ok: false, reason: error ? "error" : "state", error: error ?? undefined };
  }
  if (error) return { ok: false, reason: "error", error };
  const code = params.get("code");
  if (!code) return { ok: false, reason: "state" };
  return { ok: true, code };
}

// ---- reauth token handover (memory only, 5 minutes, single use) ----------------------------------

let reauth: { token: string; expiresAt: number } | null = null;

export function setReauthToken(token: string, expiresIn: number): void {
  reauth = { token, expiresAt: Date.now() + expiresIn * 1000 };
  // The same token confirms every other sensitive change of this session (PROTOCOL.md §5c).
  setReauth(token, expiresIn);
}

export function takeReauthToken(): string | null {
  const r = reauth;
  reauth = null;
  return r && r.expiresAt > Date.now() ? r.token : null;
}

export function hasReauthToken(): boolean {
  return !!reauth && reauth.expiresAt > Date.now();
}

/**
 * `TavrnApi` whose identity reset sends the reauth token instead of the password (§8.4), so the
 * encryption module can stay unaware of SSO. Everything else is the original client.
 */
export function withReauthToken(api: TavrnApi, token: string): TavrnApi {
  const wrapped = Object.create(api) as TavrnApi;
  wrapped.keys = { ...api.keys, resetIdentity: (req) => api.keys.resetIdentity({ identity_public_key: req.identity_public_key, reauth_token: token }) };
  return wrapped;
}

// ---- "also sign out at the provider" after a logout (§8.6) -----------------------------------------

export function rememberSsoLogout(url: string): void {
  try {
    if (/^https?:\/\//.test(url)) sessionStorage.setItem(LOGOUT_KEY, url);
  } catch {
    /* storage unavailable: the offer is skipped */
  }
}

/** The provider's logout URL of the last SSO sign-out in this tab, if any. */
export function peekSsoLogout(): string | null {
  try {
    const url = sessionStorage.getItem(LOGOUT_KEY);
    return url && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

export function forgetSsoLogout(): void {
  try {
    sessionStorage.removeItem(LOGOUT_KEY);
  } catch {
    /* ignore */
  }
}
