// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions of other nodes (FEDERATION.md §2.5, §8): the web client is a client of several nodes. The
 * home node session lives in `useAuth`; for every other node the user talks to (rooms on other nodes,
 * the node this client was loaded from after signing in with an account of another node) this store
 * keeps a **federated session**: the node's endpoints from its discovery document, a federation token
 * from the home node (`POST /federation/token`) exchanged on the node (`POST /auth/federated`).
 *
 * - One {@link TavrnApi} per node ({@link apiFor}); room and conversation ids are node-scoped.
 * - Renewal: access tokens refresh on 401 (`/auth/refresh` of that node); when that fails, or before the
 *   7-day cap of the federated session ends, a fresh federation token is exchanged.
 * - A node that cannot be reached is only marked unreachable (`useReach`); nothing else breaks.
 */
import { create } from "zustand";
import { TavrnApi, TavrnApiError, createRefresher, isNodeDomain, resolveNode, type FederatedSessionResponse, type NodeEndpoints, type UserKeys, type UserPrivate, type WellKnown } from "@tavrn/sdk";
import { CLIENT_HEADER, api, publicApi } from "../lib/api";
import { useAuth } from "./auth";
import { trackingFetch, useReach } from "./reach";
import { allowsInsecureNodes, deviceName, originUrl, originWsUrl, webOrigin } from "../platform";

const KEY = "tavrn.nodes";
/** Renew a federated session when less than this is left of its 7-day cap. */
export const RENEW_BEFORE_MS = 24 * 3600 * 1000;
/** Discovery documents are cached for at most one hour (§1.4). */
export const DISCOVERY_TTL_MS = 3600 * 1000;

export interface FederatedSession extends NodeEndpoints {
  token: string;
  refresh: string;
  /** The home device id (the identity of this device everywhere). */
  deviceId: string;
  /** The user as that node knows it (its user id is node-local). */
  user: UserPrivate;
  /** End of the federated session (epoch ms), whatever the refreshes. */
  expiresAt: number;
}

function load(): Record<string, FederatedSession> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Record<string, FederatedSession>;
  } catch {
    /* storage unavailable */
  }
  return {};
}

function save(sessions: Record<string, FederatedSession>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions));
  } catch {
    /* storage unavailable: sessions are re-established on the next start */
  }
}

interface NodesState {
  sessions: Record<string, FederatedSession>;
  /**
   * Nodes whose federated session could not be renewed because a node refused it (error code), not
   * because it was unreachable: only these nodes ask the user to sign in there again.
   */
  failed: Record<string, string>;
  put: (s: FederatedSession) => void;
  update: (domain: string, patch: Partial<FederatedSession>) => void;
  drop: (domain: string) => void;
  clear: () => void;
  fail: (domain: string, code: string) => void;
}

/** Federated sessions as stored for every tab; null when the storage cannot be read. */
function readStoredSessions(): Record<string, FederatedSession> | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, FederatedSession>) : {};
  } catch {
    return null;
  }
}

export const useNodes = create<NodesState>((set, get) => ({
  sessions: load(),
  failed: {},
  put: (s) => {
    const sessions = { ...get().sessions, [s.domain]: s };
    save(sessions);
    const { [s.domain]: _ok, ...failed } = get().failed;
    set({ sessions, failed });
  },
  fail: (domain, code) => set((st) => ({ failed: { ...st.failed, [domain]: code } })),
  update: (domain, patch) => {
    const current = get().sessions[domain];
    if (!current) return;
    const sessions = { ...get().sessions, [domain]: { ...current, ...patch } };
    save(sessions);
    set({ sessions });
  },
  drop: (domain) => {
    const { [domain]: _gone, ...sessions } = get().sessions;
    save(sessions);
    set({ sessions });
  },
  clear: () => {
    save({});
    set({ sessions: {}, failed: {} });
  },
}));

/** Replaceable pieces (tests). */
export const nodeDeps = {
  now: () => Date.now(),
  /**
   * Discovery: the node this client was loaded from is reached on this origin (desktop app: the chosen node) (its identity domain comes
   * from its discovery document, never from `location`); any other node through the well-known of its
   * identity domain, whose endpoints may live on another host (delegation, design note 4.2c), otherwise
   * through the resolution of this client's node (which also reads `_tavrn._tcp` SRV records).
   */
  discover: async (domain: string): Promise<NodeEndpoints> => {
    const own = await originDocument().catch(() => null);
    if (own?.domain === domain) {
      return { domain, base: originUrl(), ws: originWsUrl(), web: webOrigin() };
    }
    // The own node resolves like nodes do among themselves (well-known → SRV → domain): SRV-only setups work too.
    return resolveNode(domain, { resolve: (d) => publicApi.federation.resolve(d), allowInsecure: typeof location !== "undefined" && allowsInsecureNodes() });
  },
  /** The home node's client (federation tokens). */
  home: (): TavrnApi => api,
};

let origin: Promise<WellKnown> | null = null;

/** Discovery document of the node this web client was loaded from (fetched once). */
function originDocument(): Promise<WellKnown> {
  origin ??= publicApi.node.wellKnown().catch((e: unknown) => {
    origin = null;
    throw e;
  });
  return origin;
}

const discovered = new Map<string, { at: number; endpoints: NodeEndpoints }>();

/** Endpoints of `domain` (cached for an hour). */
export async function endpointsOf(domain: string): Promise<NodeEndpoints> {
  const hit = discovered.get(domain);
  if (hit && nodeDeps.now() - hit.at < DISCOVERY_TTL_MS) return hit.endpoints;
  const endpoints = await nodeDeps.discover(domain);
  discovered.set(domain, { at: nodeDeps.now(), endpoints });
  return endpoints;
}

/** The home node's domain (null while signed out). */
export function homeDomain(): string | null {
  return useAuth.getState().user?.domain ?? null;
}

export function isHome(domain: string | null | undefined): boolean {
  return !domain || domain === homeDomain();
}

function toSession(endpoints: NodeEndpoints, resp: FederatedSessionResponse): FederatedSession {
  const expiresAt = Date.parse(resp.session_expires_at);
  return {
    ...endpoints,
    token: resp.access_token,
    refresh: resp.refresh_token,
    deviceId: resp.device_id,
    user: resp.user,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : nodeDeps.now() + 7 * 24 * 3600 * 1000,
  };
}

const inflight = new Map<string, Promise<FederatedSession>>();

/** A federated login on `domain` with a fresh federation token of the home node. */
async function login(domain: string): Promise<FederatedSession> {
  const endpoints = await endpointsOf(domain);
  const { token } = await nodeDeps.home().federation.token(domain);
  const target = new TavrnApi({ baseUrl: endpoints.base, clientHeader: CLIENT_HEADER, fetchImpl: trackingFetch(() => domain) });
  const session = toSession(endpoints, await target.auth.federated(token, deviceName()));
  useNodes.getState().put(session);
  return session;
}

/**
 * A usable session for `domain`: the stored one, or a new federated login when there is none, it ends
 * within {@link RENEW_BEFORE_MS}, or `force` is set. Concurrent callers share one login.
 */
export function connectNode(domain: string, opts: { force?: boolean } = {}): Promise<FederatedSession> {
  if (isHome(domain)) return Promise.reject(new Error("the home node needs no federated session"));
  const current = useNodes.getState().sessions[domain];
  if (current && !opts.force && current.expiresAt - nodeDeps.now() > RENEW_BEFORE_MS) return Promise.resolve(current);
  const running = inflight.get(domain);
  if (running) return running;
  const p = login(domain)
    .catch((e: unknown) => {
      // A node that answered with a refusal (not a network failure): ask the user to sign in there again.
      if (e instanceof TavrnApiError && e.status > 0) useNodes.getState().fail(domain, e.code ?? "unknown");
      throw e;
    })
    .finally(() => inflight.delete(domain));
  inflight.set(domain, p);
  return p;
}

const refreshers = new Map<string, () => Promise<string | null>>();

/**
 * The refresh of `domain`'s federated session, the same single-flight and cross-tab helper as the home session
 * (PROTOCOL.md §5b): resolves to the new access token, to null when the node refused the refresh token (or there is
 * no session), and throws when the node could not be reached.
 */
function refresherFor(domain: string): () => Promise<string | null> {
  let r = refreshers.get(domain);
  if (!r) {
    r = createRefresher({
      lockName: `tavrn-refresh:node:${domain}`,
      current: () => useNodes.getState().sessions[domain]?.refresh ?? null,
      shared: () => {
        const stored = readStoredSessions();
        if (!stored) return null;
        const s = stored[domain];
        // A session of this node dropped in another tab: a new federated login follows, not a sign-out.
        return s ? { access: s.token, refresh: s.refresh } : null;
      },
      adopt: (t) => useNodes.getState().update(domain, { token: t.access, refresh: t.refresh }),
      call: (refresh) => {
        const base = useNodes.getState().sessions[domain]?.base ?? `https://${domain}`;
        return new TavrnApi({ baseUrl: base, clientHeader: CLIENT_HEADER, fetchImpl: trackingFetch(() => domain) }).auth.refresh(refresh);
      },
      store: (pair) => useNodes.getState().update(domain, { token: pair.access_token, refresh: pair.refresh_token }),
      onInvalid: () => undefined,
    });
    refreshers.set(domain, r);
  }
  return r;
}

/**
 * After a 401 or a `4001` of `domain`: rotate the refresh token; if the node refuses it (`auth.refresh_invalid`,
 * e.g. after the 7-day cap or a revocation), log in again with a fresh federation token. Returns the new access
 * token, null when the nodes refused, and throws when a node could not be reached (the session stays).
 */
export async function refreshNode(domain: string): Promise<string | null> {
  const token = await refresherFor(domain)();
  if (token) return token;
  try {
    return (await connectNode(domain, { force: true })).token;
  } catch (e) {
    if (e instanceof TavrnApiError && e.status > 0) return null;
    throw e;
  }
}

/** {@link refreshNode} for the API clients: null on any failure (the request then fails as it is). */
export async function renew(domain: string): Promise<string | null> {
  try {
    return await refreshNode(domain);
  } catch {
    return null;
  }
}

/** Renews every federated session that ends within {@link RENEW_BEFORE_MS} (best effort). */
export async function renewExpiring(): Promise<void> {
  const now = nodeDeps.now();
  await Promise.all(
    Object.values(useNodes.getState().sessions)
      .filter((s) => s.expiresAt - now <= RENEW_BEFORE_MS)
      .map((s) => connectNode(s.domain, { force: true }).catch(() => undefined)),
  );
}

const clients = new Map<string, TavrnApi>();

/**
 * The API client for rooms and conversations on `domain`: the home client for the home node, else a
 * client with the federated session of that node (which must exist, see {@link connectNode}).
 */
export function apiFor(domain: string | null | undefined): TavrnApi {
  if (isHome(domain)) return api;
  const d = domain as string;
  let client = clients.get(d);
  if (!client) {
    client = new TavrnApi({
      baseUrl: () => useNodes.getState().sessions[d]?.base ?? `https://${d}`,
      clientHeader: CLIENT_HEADER,
      fetchImpl: trackingFetch(() => d),
      getToken: () => useNodes.getState().sessions[d]?.token ?? null,
      refreshToken: () => renew(d),
    });
    clients.set(d, client);
  }
  return client;
}

const publicClients = new Map<string, TavrnApi>();

/**
 * Public keys (identity key, attested devices) of `address`, always from the user's **home node**
 * (FEDERATION.md §3.5): the home client for this account's own node, otherwise the public, CORS-open
 * route of the node named by the address, found through discovery (no session needed). The node hosting
 * a conversation is never asked: its view of foreign keys is a cache clients must not rely on.
 */
export async function homeKeys(address: string): Promise<UserKeys> {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (at < 1 || !domain) throw notFound(address);
  if (isHome(domain)) return api.keys.get(address);
  if (!isNodeDomain(domain)) throw notFound(address);
  await endpointsOf(domain);
  let client = publicClients.get(domain);
  if (!client) {
    client = new TavrnApi({ baseUrl: () => discovered.get(domain)?.endpoints.base ?? `https://${domain}`, clientHeader: CLIENT_HEADER, fetchImpl: trackingFetch(() => domain) });
    publicClients.set(domain, client);
  }
  return client.keys.get(address);
}

function notFound(address: string): TavrnApiError {
  return new TavrnApiError({ type: "about:blank", title: "Not found", status: 404, detail: address, code: "user.not_found" });
}

/** The user as `domain` knows it (node-local id). */
export function meOn(domain: string | null | undefined): UserPrivate | null {
  if (isHome(domain)) return useAuth.getState().user;
  return useNodes.getState().sessions[domain as string]?.user ?? null;
}

/** Ends all federated sessions (best effort) and forgets them. */
export async function signOutNodes(): Promise<void> {
  const sessions = Object.keys(useNodes.getState().sessions);
  await Promise.all(sessions.map((d) => apiFor(d).auth.logout().catch(() => undefined)));
  useNodes.getState().clear();
  clients.clear();
  publicClients.clear();
  discovered.clear();
  refreshers.clear();
  useReach.setState({ nodes: {} });
}

// Another tab rotated or replaced federated sessions: take them over (PROTOCOL.md §5b).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY && e.key !== null) return;
    const stored = readStoredSessions();
    if (stored) useNodes.setState({ sessions: stored });
  });
}

/** Forget the discovery cache (tests). */
export function resetNodeCaches(): void {
  refreshers.clear();
  clients.clear();
  publicClients.clear();
  discovered.clear();
  inflight.clear();
}
