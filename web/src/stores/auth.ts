// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import type { AuthResponse, TokenPair, UserPrivate } from "@tavrn/sdk";
import { clearReauth, setReauth } from "./reauth";
import { webOrigin } from "../platform";

const KEY = "tavrn.auth";
/** Address of the last account signed in on this browser (device proof for passkey and SSO logins). */
const LAST_ACCOUNT = "tavrn.lastAccount";

/**
 * The account's home node when it is not the node this web client was loaded from (signed in with an
 * account of another node, FEDERATION.md §8). Absent = the home node is this origin.
 */
export interface HomeNode {
  /** Identity domain (addresses, display); the endpoints below may live on another host (design note 4.2c). */
  domain: string;
  /** Base URL for the API client (the node's `api` without `/api/v1`). */
  base: string;
  ws: string;
  /** Origin of the home node's web client (invite links of its rooms); absent in sessions of older versions. */
  web?: string;
}

interface Persisted {
  token: string | null;
  refresh: string | null;
  user: UserPrivate | null;
  /** Device id of this session (needed for device keys); null for sessions stored by older versions. */
  deviceId?: string | null;
  home?: HomeNode | null;
}

function load(): Persisted {
  return readStored() ?? { token: null, refresh: null, user: null, deviceId: null, home: null };
}

/** The session as stored for every tab; null when the storage cannot be read (not: signed out). */
export function readStored(): Persisted | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { token: null, refresh: null, user: null, deviceId: null, home: null };
    return JSON.parse(raw) as Persisted;
  } catch {
    /* private mode, blocked storage: then simply not signed in */
    return null;
  }
}

/** The address of the last account signed in on this browser, if any. */
export function lastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT);
  } catch {
    return null;
  }
}

function save(p: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignorieren */
  }
}

/** Browser storage of an account (`<prefix>:<address>`), removed when that account signs out of this browser. */
const ACCOUNT_KEYS = ["tavrn.rail", "tavrn.legal.seen", "tavrn.terms.dismissed", "tavrn.push", "tavrn.notify.entries"];
/** Unscoped per-account storage (conversation ids), removed on every sign-out. */
const SIGNED_IN_KEYS = ["tavrn.closed-dms"];

type AccountListener = (previous: string | null) => void;
const accountListeners = new Set<AccountListener>();

/**
 * Runs `fn` whenever the account signed in on this tab ends (sign-out, forced sign-out, another tab signing out or
 * in with another account), with the previous address: caches and sessions of that account must go. Returns the
 * unsubscribe function.
 */
export function onAccountChange(fn: AccountListener): () => void {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
}

function accountEnded(previous: string | null) {
  if (previous) {
    try {
      for (const k of ACCOUNT_KEYS) localStorage.removeItem(`${k}:${previous}`);
      for (const k of SIGNED_IN_KEYS) localStorage.removeItem(k);
    } catch {
      /* storage unavailable */
    }
  }
  for (const fn of accountListeners) {
    try {
      fn(previous);
    } catch (e) {
      console.error("sign-out cleanup failed", e);
    }
  }
}

let explicitSignOuts = 0;

/**
 * Marks an explicit sign-out (stores/e2ee `signOut`) until the returned function runs. Meanwhile a refused session
 * ({@link AuthState.sessionRefused}) leaves the account signed in: the node revokes the session while the sign-out
 * still waits for its answer and deletes the local data, and the sign-out ends the account itself afterwards.
 */
export function beginSignOut(): () => void {
  explicitSignOuts++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    explicitSignOuts--;
  };
}

const persisted = (s: Persisted): Persisted => ({ token: s.token, refresh: s.refresh, user: s.user, deviceId: s.deviceId ?? null, home: s.home ?? null });

export interface AuthState extends Persisted {
  /** A new session of the home node; `home` is the home node when it is not this origin. */
  setSession: (resp: AuthResponse, home?: HomeNode | null) => void;
  setTokens: (t: TokenPair) => void;
  setUser: (u: UserPrivate) => void;
  setDeviceId: (id: string) => void;
  /** Takes over what another tab stored (rotated tokens, sign-out, another account). */
  adoptStored: () => void;
  logout: () => void;
  /**
   * The home node refused the session (refused refresh token, socket closed for authentication): signs out, unless an
   * explicit sign-out is running ({@link beginSignOut}), which signs out once the local data is gone. Nothing happens
   * when no account is signed in.
   */
  sessionRefused: () => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  ...load(),
  setSession: (resp, home = null) => {
    const previous = get().user?.address ?? null;
    const next = { token: resp.access_token, refresh: resp.refresh_token, user: resp.user, deviceId: resp.device_id, home };
    save(next);
    set(next);
    // The login was a fresh proof: sensitive changes need no further confirmation for five minutes.
    clearReauth();
    setReauth(resp.reauth_token);
    try {
      localStorage.setItem(LAST_ACCOUNT, resp.user.address);
    } catch {
      /* ignorieren */
    }
    if (previous && previous !== resp.user.address) accountEnded(previous);
  },
  setTokens: (t) => {
    const next = { ...persisted(get()), token: t.access_token, refresh: t.refresh_token, deviceId: t.device_id ?? get().deviceId };
    save(next);
    set({ token: t.access_token, refresh: t.refresh_token, deviceId: next.deviceId });
  },
  setUser: (user) => {
    save({ ...persisted(get()), user });
    set({ user });
  },
  setDeviceId: (deviceId) => {
    save({ ...persisted(get()), deviceId });
    set({ deviceId });
  },
  adoptStored: () => {
    const stored = readStored();
    if (!stored) return;
    const cur = get();
    if (stored.token === cur.token && stored.refresh === cur.refresh && stored.user?.address === cur.user?.address && stored.deviceId === cur.deviceId) return;
    set(persisted(stored));
    const previous = cur.user?.address ?? null;
    if (previous && previous !== stored.user?.address) accountEnded(previous);
  },
  logout: () => {
    const previous = get().user?.address ?? null;
    clearReauth();
    const next = { token: null, refresh: null, user: null, deviceId: null, home: null };
    save(next);
    set(next);
    accountEnded(previous);
  },
  sessionRefused: () => {
    // Signed out already (a refresh refused after the sign-out finished): no account ends a second time, or the
    // cleanup would empty the query cache under the login page's queries (web #167).
    const { token, refresh, user } = get();
    if (!token && !refresh && !user) return;
    if (explicitSignOuts === 0) get().logout();
  },
}));

/**
 * The identity of the signed-in session: account and device, null when signed out. Unlike the access token it does
 * not change with a token refresh (hourly, or another tab's rotation): effects that set up a signed-in session
 * (index sync, push registration, notification settings, presence, the search sync) are keyed on it.
 */
export function sessionKey(s: Pick<AuthState, "token" | "user" | "deviceId">): string | null {
  return s.token && s.user ? `${s.user.address}/${s.deviceId ?? ""}` : null;
}

/** {@link sessionKey} of the current session; re-renders only when the account or the device changes. */
export function useSessionKey(): string | null {
  return useAuth(sessionKey);
}

// Other tabs rotate tokens and sign in or out: follow them (PROTOCOL.md §5b), so no tab keeps presenting a refresh
// token that another tab already rotated.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) useAuth.getState().adoptStored();
  });
}

/**
 * Origin of the home node's web client: this origin (desktop app: the chosen node), or the remote home's `web` (its host may differ from
 * the identity domain, design note 4.2c).
 */
export function homeWeb(): string {
  return useAuth.getState().home?.web ?? webOrigin();
}

/** `true` when the account's home node is not the node this web client was loaded from. */
export function homeIsRemote(): boolean {
  return !!useAuth.getState().home;
}
