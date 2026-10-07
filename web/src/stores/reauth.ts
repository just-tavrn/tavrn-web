// SPDX-License-Identifier: Apache-2.0
/**
 * Sudo mode of the web client (PROTOCOL.md §5c): the reauth token of this session (memory only, five minutes) and
 * the pending confirmation request that {@link ReauthDialog} answers. The API client sends the token with every
 * request and, on `403 auth.reauth_required`, asks here and repeats the request once.
 */
import { create } from "zustand";

interface Pending {
  methods: string[];
  resolve: (ok: boolean) => void;
}

interface ReauthState {
  token: string | null;
  expiresAt: number;
  pending: Pending | null;
}

export const useReauth = create<ReauthState>(() => ({ token: null, expiresAt: 0, pending: null }));

/** Remembers a reauth token (login response, confirmation dialog, SSO reauth flow). */
export function setReauth(token: string | null | undefined, expiresInSecs = 300): void {
  if (!token) return;
  // A little earlier than the node, so a request never races the expiry.
  useReauth.setState({ token, expiresAt: Date.now() + Math.max(0, expiresInSecs - 10) * 1000 });
}

/** The current reauth token, or null once it expired. */
export function currentReauth(): string | null {
  const { token, expiresAt } = useReauth.getState();
  return token && expiresAt > Date.now() ? token : null;
}

export function clearReauth(): void {
  useReauth.setState({ token: null, expiresAt: 0 });
}

/**
 * Asks the user to confirm (dialog); resolves true once a fresh reauth token is stored, false when cancelled.
 * Concurrent requests share one dialog.
 */
export function requestReauth(methods: string[]): Promise<boolean> {
  const current = useReauth.getState().pending;
  if (current) {
    return new Promise((resolve) => {
      const prev = current.resolve;
      current.resolve = (ok) => {
        prev(ok);
        resolve(ok);
      };
    });
  }
  // A stale token is what got refused: drop it.
  clearReauth();
  return new Promise((resolve) => useReauth.setState({ pending: { methods, resolve } }));
}

/** Answers the open request (the dialog). */
export function finishReauth(ok: boolean): void {
  const p = useReauth.getState().pending;
  useReauth.setState({ pending: null });
  p?.resolve(ok);
}
