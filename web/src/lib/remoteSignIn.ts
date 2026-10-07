// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in with an account of another node on this web client (FEDERATION.md §8).
 *
 * - **Direct flow**: password and second factor (TOTP or recovery code) against the home node's API,
 *   cross-origin with bearer tokens.
 * - **Connect flow** (passkeys, captcha, anything else): redirect to `<home web>/connect` with `origin`,
 *   a random `state` and a PKCE challenge (S256); the home node's client sends the user back to
 *   `/connect/callback?code&state&node`, and the code plus verifier give a session of a new device.
 *
 * Both end in a home session (account, keys, friends, DMs, index stay on the home node) plus a federated
 * session for the node this client was loaded from.
 */
import { TavrnApi, createPkce, randomUrlSafe, type AuthResponse, type NodeEndpoints } from "@tavrn/sdk";
import { CLIENT_HEADER, publicApi } from "./api";
import { useAuth } from "../stores/auth";
import { connectNode } from "../stores/nodes";

const PENDING_KEY = "tavrn.connect";
/** A connect flow older than this is not completed (the code itself lives 2 minutes). */
export const CONNECT_MAX_AGE_MS = 15 * 60 * 1000;

export interface PendingConnect {
  state: string;
  verifier: string;
  endpoints: NodeEndpoints;
  /** Where to go after the sign-in (an app path). */
  next: string;
  startedAt: number;
  /** The account (`user@domain`) the user named: its device in this browser, if any, is continued (device proof). */
  address?: string;
}

/** API client of the home node during the sign-in (no session yet). */
export function homeClient(endpoints: NodeEndpoints): TavrnApi {
  return new TavrnApi({ baseUrl: endpoints.base, clientHeader: CLIENT_HEADER });
}

/** Only app paths are followed after a sign-in (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * Starts the connect flow: remembers state, verifier and endpoints for this tab, then returns the URL of
 * the home node's `/connect` page.
 */
export async function startConnect(endpoints: NodeEndpoints, next: string, address?: string): Promise<string> {
  const { verifier, challenge } = await createPkce();
  const pending: PendingConnect = { state: randomUrlSafe(), verifier, endpoints, next: safeNext(next), startedAt: Date.now(), address };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(`${endpoints.web}/connect`);
  url.searchParams.set("origin", location.origin);
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", challenge);
  return url.toString();
}

/** Takes the pending connect flow of this tab (single use). */
export function takePendingConnect(): PendingConnect | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingConnect) : null;
  } catch {
    return null;
  }
}

export type CallbackCheck = { ok: true; code: string } | { ok: false; reason: "state" | "cancelled" | "invalid" };

/** Checks the callback parameters against the flow this tab started (state, node, age). */
export function checkCallback(params: URLSearchParams, pending: PendingConnect | null, now = Date.now()): CallbackCheck {
  if (!pending || params.get("state") !== pending.state || now - pending.startedAt > CONNECT_MAX_AGE_MS) return { ok: false, reason: "state" };
  if (params.get("error")) return { ok: false, reason: "cancelled" };
  const code = params.get("code");
  if (!code || params.get("node") !== pending.endpoints.domain) return { ok: false, reason: "invalid" };
  return { ok: true, code };
}

/**
 * Stores the home session and opens the federated session for the node this client was loaded from
 * (best effort: the app retries when its rooms are opened).
 */
export async function completeRemoteSignIn(session: AuthResponse, endpoints: NodeEndpoints): Promise<void> {
  useAuth.getState().setSession(session, { domain: endpoints.domain, base: endpoints.base, ws: endpoints.ws, web: endpoints.web });
  const origin = await publicApi.node.wellKnown().catch(() => null);
  if (origin && origin.domain !== endpoints.domain) await connectNode(origin.domain).catch(() => undefined);
}

/** Origin of an URL, for display (`https://b.example` → `b.example`). */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
