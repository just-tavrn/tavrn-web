// SPDX-License-Identifier: Apache-2.0
import { TavrnApi, createRefresher } from "@tavrn/sdk";
import { readStored, useAuth } from "../stores/auth";
import { currentReauth, requestReauth } from "../stores/reauth";
import { trackingFetch } from "../stores/reach";

export const CLIENT_HEADER = "tavrn-web/0.0.1 (content.v1, reactions, e2ee.mls1)";

/** Base URL of the account's home node: this origin unless signed in with an account of another node. */
export const homeBase = () => useAuth.getState().home?.base ?? "";
const homeDomain = () => useAuth.getState().user?.domain ?? null;

/**
 * Refresh of the home node session (PROTOCOL.md §5b): one refresh at a time in this tab, coordinated with the other
 * tabs through the Web Locks API and the shared storage; network errors keep the session (the request fails, the UI
 * stays usable), only a refused refresh token signs out. Shared by the API client and the WebSocket.
 */
export const refreshHome = createRefresher({
  lockName: "tavrn-refresh:home",
  current: () => useAuth.getState().refresh,
  shared: () => {
    const stored = readStored();
    return stored ? { access: stored.token, refresh: stored.refresh } : null;
  },
  adopt: () => useAuth.getState().adoptStored(),
  call: (refresh) => new TavrnApi({ baseUrl: homeBase(), clientHeader: CLIENT_HEADER }).auth.refresh(refresh),
  store: (pair) => useAuth.getState().setTokens(pair),
  onInvalid: () => useAuth.getState().logout(),
});

/**
 * Client of the account's home node (account, keys, friends, DMs, index, and the rooms of the home
 * node). Usually the node the web client was loaded from; after signing in with an account of another
 * node (FEDERATION.md §8) that other node, called cross-origin with bearer tokens.
 */
export const api = new TavrnApi({
  baseUrl: homeBase,
  clientHeader: CLIENT_HEADER,
  fetchImpl: trackingFetch(homeDomain),
  getToken: () => useAuth.getState().token,
  refreshToken: refreshHome,
  // Sudo mode (PROTOCOL.md §5c): the reauth token of this session, and the confirmation dialog when it is missing.
  reauthToken: currentReauth,
  onReauthRequired: requestReauth,
});

/** The home client without the confirmation dialog: background work that must not prompt (it fails instead). */
export const quietApi = new TavrnApi({
  baseUrl: homeBase,
  clientHeader: CLIENT_HEADER,
  fetchImpl: trackingFetch(homeDomain),
  getToken: () => useAuth.getState().token,
  refreshToken: refreshHome,
  reauthToken: currentReauth,
});

/**
 * The node this web client was loaded from, without a session: node info and captcha of the login
 * page, password step, second factor and passkey login, the peer document proxy.
 */
export const publicApi = new TavrnApi({ baseUrl: "", clientHeader: CLIENT_HEADER });

/** WebSocket of the home node. */
export function wsUrl(): string {
  const home = useAuth.getState().home;
  if (home) return home.ws;
  const base = location.origin.replace(/^http/, "ws");
  return `${base}/api/v1/ws`;
}
