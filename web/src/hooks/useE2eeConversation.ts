// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from "react";
import { archivedDecrypted } from "../history/local";
import type { Message } from "@tavrn/sdk";
import { useE2ee } from "../stores/e2ee";
import { getMls, useMlsUi } from "../stores/mls";
import type { Decrypted, GhostViolation, MlsManager, PlainStatus } from "@tavrn/e2ee";
import { describeError } from "../stores/toasts";
import { cleanupConversation } from "../lib/leafCleanup";

/**
 * While a DM member has no attested device, look again this often: the node does not announce new
 * device keys (e.g. after the member reset their identity and attested a new device).
 */
export const WAITING_RETRY_MS = 5_000;

export type E2eePhase = "plain" | "locked" | "joining" | "ready" | "no_group" | "error";

export interface E2eeConversation {
  phase: E2eePhase;
  mls: MlsManager | null;
  /** Other members without any attested device (DMs: sending waits for them). */
  waiting: string[];
  /** Ghost member violations (§4.6). */
  ghosts: GhostViolation[];
  /** This device had to rejoin after an invalid commit. */
  rejoined: boolean;
  error: string | null;
  /** Bumps whenever the group changed (decrypt again). */
  tick: number;
}

/**
 * Joins the MLS group of an encrypted conversation (qualified id `<hosting node>/<ulid>`) when it is
 * opened and keeps the roster checked against the hosting node's member list:
 * DM/group members' devices are added by Welcome, the roster is compared with `members` (ghost check)
 * and leaves of users who are no longer members are removed when the user may manage the conversation.
 */
export function useE2eeConversation(opts: {
  /** Qualified conversation id. */
  conversationId: string;
  encrypted: boolean;
  canCreate: boolean;
  /** Addresses entitled to be in the group; null while loading. */
  members: string[] | null;
  /** DMs and group DMs: member addresses (of any node) whose devices are added by Welcome. */
  direct?: string[];
  mayManage: boolean;
  /** Loads the member list again, bypassing caches (before acting on a violation). */
  refreshMembers?: () => Promise<string[]>;
  /** The channel's effective "no bots" flag: bot leaves are ghost members (APPLICATIONS.md §3.5). */
  noBots?: boolean;
}): E2eeConversation {
  const status = useE2ee((s) => s.status);
  const tick = useMlsUi((s) => s.epochs[opts.conversationId] ?? 0);
  const rejoined = useMlsUi((s) => !!s.rejoined[opts.conversationId]);
  // Acknowledging a changed security key lets its devices count (ENCRYPTION.md §3.3): add them and check again.
  const changedKey = useMlsUi((s) => Object.keys(s.changedKeys).sort().join(","));
  const [state, setState] = useState<Omit<E2eeConversation, "tick" | "rejoined">>({ phase: "joining", mls: null, waiting: [], ghosts: [], error: null });
  // The member lists change with their queries only: sorted once per list, not on every render (big rooms).
  const membersKey = useMemo(() => (opts.members ? [...opts.members].sort().join(",") : null), [opts.members]);
  const directKey = useMemo(() => (opts.direct ? [...opts.direct].sort().join(",") : ""), [opts.direct]);
  const { conversationId, encrypted, canCreate, mayManage } = opts;
  const noBots = !!opts.noBots;
  const members = opts.members;
  const direct = opts.direct;
  const refreshMembers = useRef(opts.refreshMembers);
  const [retry, setRetry] = useState(0);
  refreshMembers.current = opts.refreshMembers;

  useEffect(() => {
    if (!encrypted) {
      // Plaintext now, but older messages may be encrypted: decrypt them if this device can.
      setState({ phase: "plain", mls: null, waiting: [], ghosts: [], error: null });
      let stale = false;
      if (status === "unlocked") void getMls().then((mls) => !stale && setState((s) => ({ ...s, mls })));
      return () => {
        stale = true;
      };
    }
    if (status !== "unlocked") {
      setState({ phase: status === null ? "joining" : "locked", mls: null, waiting: [], ghosts: [], error: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const mls = await getMls();
      if (cancelled) return;
      if (!mls) return setState({ phase: "locked", mls: null, waiting: [], ghosts: [], error: null });
      try {
        const joined = await mls.ensureJoined(conversationId, { canCreate });
        if (cancelled) return;
        if (joined === "no_group") return setState({ phase: "no_group", mls, waiting: [], ghosts: [], error: null });
        const waiting = direct ? await mls.addMissingDevices(conversationId, direct) : [];
        let ghosts: GhostViolation[] = [];
        if (members) {
          ghosts = await mls.ghostCheck(conversationId, members, { noBots });
          if (ghosts.length) {
            // Confirm with fresh data first: the member list or a user's devices may just have changed.
            const fresh = (await refreshMembers.current?.().catch(() => null)) ?? members;
            // Ghost leaves this device may remove go (ENCRYPTION.md §4.7): own deleted devices, deleted or unattested
            // devices of anyone, departed members when the user may manage; elected, single flight, node-enforced.
            const cleaned = await cleanupConversation(conversationId, { members: fresh, mayManage, noBots }).catch(() => null);
            ghosts = cleaned ? cleaned.ghosts : await mls.ghostCheck(conversationId, fresh, { fresh: true, noBots });
          }
        }
        if (!cancelled) setState({ phase: "ready", mls, waiting, ghosts, error: null });
      } catch (e) {
        if (!cancelled) setState({ phase: "error", mls, waiting: [], ghosts: [], error: describeError(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, encrypted, canCreate, status, membersKey, directKey, mayManage, noBots, tick, retry, changedKey]);

  // Members still without a device: drop their cached device list and check again after a while.
  useEffect(() => {
    const { mls, waiting, phase } = state;
    if (phase !== "ready" || !mls || waiting.length === 0) return;
    const timer = setTimeout(() => {
      for (const address of waiting) mls.forgetDevices(address);
      setRetry((r) => r + 1);
    }, WAITING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return { ...state, rejoined, tick };
}

/** One result per message object: reused while the message object is unchanged (realtime patches replace it). */
interface Kept<T> {
  message: Message;
  value: T;
  /** The group state (`tick`, session manager) a non-final result was found under: retried when it changes. */
  gen: number;
  /** When it was found: a non-final result is also retried on the next change after {@link RETRY_NON_FINAL_MS}. */
  at: number;
}

/** A missing key or an unknown device may come from a passing failure: tried again at most this often. */
export const RETRY_NON_FINAL_MS = 30_000;

/**
 * Keeps the results of an incremental per-message check across renders: only messages that are new, changed or
 * non-final under a changed group state are handed to `run`. Unchanged results keep their identity, and the map
 * keeps its identity when nothing changed, so memoized rows do not render again.
 */
function useIncremental<T>(
  conversationId: string,
  messages: Message[],
  ready: boolean,
  genDeps: unknown[],
  final: (v: T | null) => boolean,
  run: (todo: Message[], isCancelled: () => boolean) => Promise<Map<string, T | null>>,
): Record<string, T> {
  const [map, setMap] = useState<Record<string, T>>({});
  const cache = useRef<{ conversationId: string; kept: Map<string, Kept<T | null>>; gen: number; deps: unknown[] }>({ conversationId, kept: new Map(), gen: 0, deps: genDeps });
  if (cache.current.conversationId !== conversationId) cache.current = { conversationId, kept: new Map(), gen: 0, deps: genDeps };
  const c = cache.current;
  if (genDeps.length !== c.deps.length || genDeps.some((d, i) => d !== c.deps[i])) {
    c.gen++;
    c.deps = genDeps;
  }
  const gen = c.gen;
  useEffect(() => {
    if (!ready || messages.length === 0) return;
    let cancelled = false;
    // Pages dropped from the window (older history trimmed) leave their results behind: forget them now and then.
    if (c.kept.size > 2 * messages.length + 100) {
      const present = new Set(messages.map((m) => m.id));
      for (const id of c.kept.keys()) if (!present.has(id)) c.kept.delete(id);
    }
    const publish = () => {
      setMap((prev) => {
        const next: Record<string, T> = {};
        let changed = false;
        let count = 0;
        for (const m of messages) {
          const v = c.kept.get(m.id)?.value;
          if (v === null || v === undefined) continue;
          next[m.id] = v;
          count++;
          if (prev[m.id] !== v) changed = true;
        }
        return changed || count !== Object.keys(prev).length ? next : prev;
      });
    };
    // A replaced message object (edit, reaction, any envelope change) is checked again: the session manager caches
    // by the exact input, so this costs a lookup, and the check covers every envelope field it binds.
    const now = Date.now();
    const todo = messages.filter((m) => {
      const k = c.kept.get(m.id);
      return !(k && k.message === m && (final(k.value) || (k.gen === gen && now - k.at < RETRY_NON_FINAL_MS)));
    });
    if (todo.length === 0) {
      publish();
      return;
    }
    void (async () => {
      const results = await run(todo, () => cancelled).catch(() => new Map<string, T | null>());
      // Results stay valid for their message object even when this run was superseded.
      const at = Date.now();
      for (const m of todo) {
        if (!results.has(m.id)) continue;
        const value = results.get(m.id) ?? null;
        const old = c.kept.get(m.id);
        c.kept.set(m.id, { message: m, value: old && sameResult(old.value, value) ? old.value : value, gen, at });
      }
      if (!cancelled) publish();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, messages, ready, gen]);
  return map;
}

/** Equal results keep the old object: the same status, or the same decrypted content read again (the archive). */
function sameResult(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Signature checks of the plaintext messages in `messages` (message id → status, FEDERATION.md §10.3).
 * System messages (no device) are skipped; without a session manager (locked device) nothing is checked.
 * Incremental: a message is checked once per message object; `unverifiable` ones again when the group or an acknowledged
 * key changes.
 */
export function usePlainSignatures(conversationId: string, messages: Message[] | undefined, mls: MlsManager | null, tick: number): Record<string, PlainStatus> {
  const plain = useMemo(() => (messages ?? []).filter((m) => !m.encrypted && !!m.device_id), [messages]);
  const changedKeys = useMlsUi((s) => s.changedKeys);
  return useIncremental<PlainStatus>(
    conversationId,
    plain,
    !!mls,
    [mls, tick, changedKeys],
    (v) => v !== null && v !== "unverifiable",
    async (todo, isCancelled) => {
      const out = new Map<string, PlainStatus | null>();
      for (const m of todo) {
        if (isCancelled() || !mls) break;
        try {
          out.set(m.id, await mls.verifyPlaintext(conversationId, m));
        } catch {
          out.set(m.id, "unverifiable");
        }
      }
      return out;
    },
  );
}

/**
 * Decrypted content of the encrypted messages in `messages` (message id → result). Plaintext messages
 * are not included. Results live in memory only. Incremental: a message is decrypted (or read from the archive) once
 * per message object; results without a key yet are tried again when the group changes.
 */
export function useDecrypted(conversationId: string, messages: Message[] | undefined, mls: MlsManager | null, tick: number): Record<string, Decrypted> {
  const encrypted = useMemo(() => (messages ?? []).filter((m) => m.encrypted), [messages]);
  return useIncremental<Decrypted>(
    conversationId,
    encrypted,
    true,
    [mls, tick],
    (v) => v !== null && (v.ok || (v.reason !== "missing_key" && v.reason !== "locked")),
    async (todo, isCancelled) => {
      // "Keep the full history on this device" (#4): content this device archived is used as it is (also offline,
      // before the session manager is there); the rest is decrypted.
      const archived = await archivedDecrypted(conversationId, todo);
      const out = new Map<string, Decrypted | null>();
      for (const m of todo) {
        const kept = archived.get(m.id);
        if (kept) {
          out.set(m.id, kept);
          continue;
        }
        if (!mls) {
          out.set(m.id, null);
          continue;
        }
        if (isCancelled()) break;
        try {
          out.set(m.id, await mls.decrypt(conversationId, m));
        } catch {
          out.set(m.id, { ok: false, reason: "invalid" });
        }
      }
      return out;
    },
  );
}
