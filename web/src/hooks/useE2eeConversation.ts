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
  const membersKey = opts.members ? [...opts.members].sort().join(",") : null;
  const directKey = opts.direct ? [...opts.direct].sort().join(",") : "";
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

/**
 * Signature checks of the plaintext messages in `messages` (message id → status, FEDERATION.md §10.3).
 * System messages (no device) are skipped; without a session manager (locked device) nothing is checked.
 */
export function usePlainSignatures(conversationId: string, messages: Message[] | undefined, mls: MlsManager | null, tick: number): Record<string, PlainStatus> {
  const [map, setMap] = useState<Record<string, PlainStatus>>({});
  const plain = useMemo(() => (messages ?? []).filter((m) => !m.encrypted && !!m.device_id), [messages]);
  const changedKeys = useMlsUi((s) => s.changedKeys);
  useEffect(() => {
    if (!mls || plain.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, PlainStatus> = {};
      for (const m of plain) {
        try {
          next[m.id] = await mls.verifyPlaintext(conversationId, m);
        } catch {
          next[m.id] = "unverifiable";
        }
      }
      if (!cancelled) setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, plain, mls, tick, changedKeys]);
  return map;
}

/**
 * Decrypted content of the encrypted messages in `messages` (message id → result). Plaintext messages
 * are not included. Results live in memory only.
 */
export function useDecrypted(conversationId: string, messages: Message[] | undefined, mls: MlsManager | null, tick: number): Record<string, Decrypted> {
  const [map, setMap] = useState<Record<string, Decrypted>>({});
  const encrypted = useMemo(() => (messages ?? []).filter((m) => m.encrypted), [messages]);
  useEffect(() => {
    if (encrypted.length === 0) return;
    let cancelled = false;
    void (async () => {
      // "Keep the full history on this device" (#4): content this device archived is used as it is (also offline,
      // before the session manager is there); the rest is decrypted.
      const archived = await archivedDecrypted(conversationId, encrypted);
      if (!mls && archived.size === 0) return;
      const next: Record<string, Decrypted> = {};
      for (const m of encrypted) {
        const kept = archived.get(m.id);
        if (kept) {
          next[m.id] = kept;
          continue;
        }
        if (!mls) continue;
        try {
          next[m.id] = await mls.decrypt(conversationId, m);
        } catch {
          next[m.id] = { ok: false, reason: "invalid" };
        }
      }
      if (!cancelled) setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, encrypted, mls, tick]);
  return map;
}
