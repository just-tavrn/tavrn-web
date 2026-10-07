// SPDX-License-Identifier: Apache-2.0
/**
 * State of an unfinished sign-in or registration (PROTOCOL.md §5a), kept in sessionStorage so that a
 * reload does not lose the step. Only the short-lived pre-auth token and non-secret progress are
 * stored; recovery codes, recovery keys and PRF outputs never are.
 */
import { create } from "zustand";
import type { PreAuthResponse, PreAuthStatus } from "@tavrn/sdk";

const PREAUTH_KEY = "tavrn.preauth";
const SETUP_KEY = "tavrn.setup";

export type FlowKind = "login" | "register";

export interface PreAuthFlow {
  token: string;
  status: PreAuthStatus;
  methods: string[];
  /** Epoch milliseconds. */
  expiresAt: number;
  kind: FlowKind;
  username: string;
}

/** Progress after the session started: which wizard the user came from (for the step indicator). */
export interface SetupProgress {
  kind: FlowKind;
}

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the flow just does not survive a reload */
  }
}

function loadPreauth(now = Date.now()): PreAuthFlow | null {
  const p = read<PreAuthFlow>(PREAUTH_KEY);
  if (!p || typeof p.token !== "string" || p.expiresAt <= now) {
    write(PREAUTH_KEY, null);
    return null;
  }
  return p;
}

interface AuthFlowState {
  preauth: PreAuthFlow | null;
  setup: SetupProgress | null;
  startPreauth: (resp: PreAuthResponse, kind: FlowKind, username: string) => void;
  clearPreauth: () => void;
  setSetup: (s: SetupProgress | null) => void;
  /** Re-reads sessionStorage and drops an expired pre-auth token. */
  refresh: () => void;
}

export const useAuthFlow = create<AuthFlowState>((set) => ({
  preauth: loadPreauth(),
  setup: read<SetupProgress>(SETUP_KEY),
  startPreauth: (resp, kind, username) => {
    const preauth: PreAuthFlow = { token: resp.preauth_token, status: resp.status, methods: resp.methods, expiresAt: Date.now() + resp.expires_in * 1000, kind, username };
    write(PREAUTH_KEY, preauth);
    set({ preauth });
  },
  clearPreauth: () => {
    write(PREAUTH_KEY, null);
    set({ preauth: null });
  },
  setSetup: (setup) => {
    write(SETUP_KEY, setup);
    set({ setup });
  },
  refresh: () => set({ preauth: loadPreauth(), setup: read<SetupProgress>(SETUP_KEY) }),
}));
