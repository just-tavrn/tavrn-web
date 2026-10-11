// SPDX-License-Identifier: Apache-2.0
/**
 * Calls in DMs and group DMs, client state (VOICE.md §11): which calls run in the conversations the user
 * sees, and which ring for this user. Fed by the WebSocket events `call.ring`, `call.update` and `call.end`
 * of every node socket (rings of conversations on other nodes arrive through the home node, their `node`
 * names the conversation's node) and by `GET …/call`. The transitions are pure functions (tested), the
 * zustand store applies them. Light: no LiveKit import.
 */
import { create } from "zustand";
import type { CallState } from "@tavrn/sdk";

/** A call stops ringing after this time even if the end event got lost (the node's ring time is 45 s). */
export const RING_MS = 45_000;

/** `<node domain>|<conversation id>`. */
export const callKey = (domain: string, conversationId: string) => `${domain}|${conversationId}`;

export interface Ring {
  domain: string;
  conversationId: string;
  /** Caller address. */
  from: string;
  startedAt: string;
  group: boolean;
  /** When this device learned about it (ms since epoch). */
  receivedAt: number;
  /** The node that named a caller who is not its own user (not verified by the caller's home node). */
  via?: string;
}

export interface CallsState {
  /** Running calls by key (absent = none known). */
  calls: Record<string, CallState>;
  /** Calls ringing for this user by key. */
  ringing: Record<string, Ring>;
}

export const EMPTY: CallsState = { calls: {}, ringing: {} };

/** `call.ring`: rings unless this device already is in the call, it was declined here, or it is too old. */
export function onRing(s: CallsState, ring: Ring, opts: { inCall: boolean; now: number; declined?: boolean }): CallsState {
  const key = callKey(ring.domain, ring.conversationId);
  const started = Date.parse(ring.startedAt);
  if (opts.inCall || opts.declined || (Number.isFinite(started) && opts.now - started > RING_MS)) return s;
  return { ...s, ringing: { ...s.ringing, [key]: ring } };
}

/** `call.update` / `GET …/call`: the state of one call; stops ringing for `me` once it is answered elsewhere. */
export function onUpdate(s: CallsState, domain: string, call: CallState, me: string | null): CallsState {
  const key = callKey(domain, call.conversation_id);
  const calls = { ...s.calls };
  if (call.active) calls[key] = call;
  else delete calls[key];
  let ringing = s.ringing;
  const stillRings = call.active && !!me && call.ringing.includes(me);
  if (key in ringing && !stillRings) {
    ringing = { ...ringing };
    delete ringing[key];
  }
  return { calls, ringing };
}

/** `call.end` (ended, missed, declined or answered on another device): nothing rings any more. */
export function onEnd(s: CallsState, domain: string, conversationId: string, reason: string): CallsState {
  const key = callKey(domain, conversationId);
  const ringing = { ...s.ringing };
  delete ringing[key];
  // "answered"/"declined" only concern this user's devices; the call itself goes on.
  if (reason === "answered" || reason === "declined") return { ...s, ringing };
  const calls = { ...s.calls };
  delete calls[key];
  return { calls, ringing };
}

/** Drops rings older than {@link RING_MS}. */
export function expireRings(s: CallsState, now: number): CallsState {
  const stale = Object.entries(s.ringing).filter(([, r]) => now - Math.max(r.receivedAt, Date.parse(r.startedAt) || 0) > RING_MS);
  if (!stale.length) return s;
  const ringing = { ...s.ringing };
  for (const [k] of stale) delete ringing[k];
  return { ...s, ringing };
}

interface CallsStore extends CallsState {
  /** Calls declined on this device (by key), so a late ring event does not ring again. */
  declined: Record<string, true>;
  /** The call view is open (false: minimized to the voice bar). */
  expanded: boolean;
  set: (fn: (s: CallsState) => CallsState) => void;
  decline: (key: string) => void;
  reset: () => void;
}

export const useCalls = create<CallsStore>((set) => ({
  ...EMPTY,
  declined: {},
  expanded: true,
  set: (fn) => set((s) => fn(s)),
  decline: (key) =>
    set((s) => {
      const ringing = { ...s.ringing };
      delete ringing[key];
      return { ringing, declined: { ...s.declined, [key]: true } };
    }),
  reset: () => set({ ...EMPTY, declined: {}, expanded: true }),
}));
