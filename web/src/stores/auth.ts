// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import type { AuthResponse, TokenPair, UserPrivate } from "@tavrn/sdk";
import { clearReauth, setReauth } from "./reauth";

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
}

export const useAuth = create<AuthState>((set, get) => ({
  ...load(),
  setSession: (resp, home = null) => {
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
  },
  logout: () => {
    clearReauth();
    const next = { token: null, refresh: null, user: null, deviceId: null, home: null };
    save(next);
    set(next);
  },
}));

// Other tabs rotate tokens and sign in or out: follow them (PROTOCOL.md §5b), so no tab keeps presenting a refresh
// token that another tab already rotated.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) useAuth.getState().adoptStored();
  });
}

/**
 * Origin of the home node's web client: this origin, or the remote home's `web` (its host may differ from
 * the identity domain, design note 4.2c).
 */
export function homeWeb(): string {
  return useAuth.getState().home?.web ?? location.origin;
}

/** `true` when the account's home node is not the node this web client was loaded from. */
export function homeIsRemote(): boolean {
  return !!useAuth.getState().home;
}
