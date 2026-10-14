// SPDX-License-Identifier: Apache-2.0
/**
 * Ghost leaf cleanup of the web client (ENCRYPTION.md §4.7): runs the shared {@link LeafCleaner} of `@tavrn/e2ee`
 * with the pending removals of the hosting node. Triggered when a conversation is opened, when a voice channel is
 * joined, on `mls.remove_needed` and after (re)connecting when the node lists pending removals of own leaves.
 * Removals stay node-enforced (§4.5 rule 4): the client only commits what the node accepts.
 *
 * A voice join never waits for the election ({@link cleanupBeforeVoice}): it ends the wait of a running cleanup and
 * shares it, an elected device removes at once, and otherwise the cleanup runs in the background once the call is
 * connected. Nothing waits for that removal: the session's fresh voice key comes from the current epoch either way
 * (§5a), and a removal later moves the epoch, which re-keys the call.
 */
import { create } from "zustand";
import { LeafCleaner, labelGhosts, splitIdentity, splitQualified, withMasterSecret, type CleanupResult, type GhostViolation, type MlsManager, type PendingRemovalLike } from "@tavrn/e2ee";
import { TavrnApiError, b64urlEncode } from "@tavrn/sdk";
import { cryptoStore } from "../crypto/store";
import { quietApi as api } from "./api";
import { getMls } from "../stores/mls";
import { apiFor } from "../stores/nodes";
import { onlineUsers } from "../stores/presence";

interface PendingState {
  /** Pending removals per qualified conversation id, as the hosting node listed them last. */
  byConversation: Record<string, PendingRemovalLike[]>;
}

export const usePendingRemovals = create<PendingState>(() => ({ byConversation: {} }));

/** Ghost violations labelled with the hosting node's pending removals (`removed`: deleted device, cleanup pending). */
export function useLabelledGhosts(q: string, ghosts: GhostViolation[]): GhostViolation[] {
  const pending = usePendingRemovals((s) => s.byConversation[q]);
  return labelGhosts(ghosts, pending);
}

const cleaners = new WeakMap<MlsManager, LeafCleaner>();

/**
 * Attests an own deleted device again as retired on the home node, from its leaf key (ENCRYPTION.md §5.2), so its
 * messages stay readable after the leaf is removed. False (keep the leaf for now) only when the node was not reached.
 */
async function reattest(mls: MlsManager, deviceId: string, key: Uint8Array): Promise<boolean> {
  try {
    const signature = withMasterSecret(cryptoStore, (m) => m.attestDevice(mls.address, deviceId, key));
    await api.users.putRetiredDevice({ device_id: deviceId, public_key: b64urlEncode(key), identity_signature: b64urlEncode(signature) });
    mls.forgetDevices(mls.address);
    return true;
  } catch (e) {
    // Refused for good (an active id, another retired key, an attestation the node rejects): the leaf goes anyway.
    return e instanceof TavrnApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
  }
}

function cleanerFor(mls: MlsManager): LeafCleaner {
  let c = cleaners.get(mls);
  if (!c) {
    c = new LeafCleaner({ mls, reattest: (deviceId, key) => reattest(mls, deviceId, key) });
    cleaners.set(mls, c);
  }
  return c;
}

/** Fetches (and remembers) the pending removals of a conversation; empty on errors. */
export async function loadPending(q: string): Promise<PendingRemovalLike[]> {
  const { domain, id } = splitQualified(q);
  try {
    const items = (await apiFor(domain).mls.pendingRemovals(id)).items;
    usePendingRemovals.setState((s) => ({ byConversation: { ...s.byConversation, [q]: items } }));
    return items;
  } catch {
    return usePendingRemovals.getState().byConversation[q] ?? [];
  }
}

export interface CleanupOptions {
  /**
   * Addresses entitled to the conversation. `undefined`: derived from the roster minus the users the node lists as
   * no longer entitled (`mls.remove_needed`); `null`: membership is not judged (only deleted/unattested leaves).
   */
  members?: string[] | null;
  mayManage: boolean;
  /** Device identities known to be online (voice participants). */
  online?: Iterable<string> | null;
  /** Users who may remove departed members' leaves (`roomManagers`); null/absent: unknown, every member counts. */
  managers?: Iterable<string> | null;
  /** The channel's effective "no bots" flag: bot leaves are ghosts and go like departed members (APPLICATIONS.md §3.5). */
  noBots?: boolean;
  /** Content waits for the removal: no election wait (`LeafCleaner`, `urgent`). */
  urgent?: boolean;
  /** A voice join: no election wait, `postponed` when another device is elected (`LeafCleaner`, `noWait`). */
  noWait?: boolean;
  /** The pending removals from a request started earlier (`loadPending`); fetched here otherwise. */
  pending?: Promise<PendingRemovalLike[]>;
}

/** Cleans the group of `q` (qualified id); null without a session manager or local group. */
export async function cleanupConversation(q: string, opts: CleanupOptions): Promise<CleanupResult | null> {
  const mls = await getMls();
  if (!mls?.hasGroup(q)) return null;
  const pending = await (opts.pending ?? loadPending(q));
  let members = opts.members ?? null;
  if (opts.members === undefined) {
    const gone = new Set(pending.filter((p) => p.reason === "not_member").map((p) => splitIdentity(p.identity).address));
    members = [...new Set(mls.roster(q).map((i) => splitIdentity(i).address))].filter((a) => !gone.has(a));
  }
  // The election counts only devices that may do the removal and users the presence lists show online (§4.7).
  const result = await cleanerFor(mls).clean({
    q,
    members,
    mayManage: opts.mayManage,
    pending,
    online: opts.online ?? null,
    onlineUsers: onlineUsers(mls.address),
    managers: opts.managers ?? null,
    noBots: opts.noBots,
    urgent: opts.urgent,
    noWait: opts.noWait,
  });
  if (result.outcome === "removed") void loadPending(q);
  return result;
}

/**
 * The ghost cleanup of a voice join (ENCRYPTION.md §4.7, before the self update that renews the voice key), without
 * waiting for the election: a running cleanup of the channel stops waiting and is shared, an elected device removes at
 * once, otherwise nothing is committed now. Resolves with a function that runs a postponed cleanup in the background
 * (with the election wait; call it once connected) and does nothing otherwise. `online`: the devices in the channel
 * (read again for the background run); `pending`: the pending removals, requested while the group was joined.
 * Best effort: failures count as nothing to do.
 */
export async function cleanupBeforeVoice(q: string, opts: { online: () => Iterable<string>; pending?: Promise<PendingRemovalLike[]> }): Promise<() => void> {
  const first = await cleanupConversation(q, { members: null, mayManage: false, online: opts.online(), noWait: true, pending: opts.pending }).catch(() => null);
  if (first?.outcome !== "postponed") return () => undefined;
  return () => void cleanupConversation(q, { members: null, mayManage: false, online: opts.online() }).catch(() => null);
}

/** Whether an error is the session manager refusing content because of an unacknowledged ghost (ENCRYPTION.md §4.6). */
export function isGhostRefusal(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "MlsError" && (e as { code?: string }).code === "ghost";
}

/**
 * Runs `attempt` (encrypting content of `q`); when the ghost check refuses it, the ghost leaves this user may remove go
 * at once and it runs once more. Right after a member left, the departed member's leaf stays in the group until a
 * removal commit: the device elected to commit it may be away, every other device waits ten seconds (§4.7), and the
 * content would be refused meanwhile (issue #86). A refusal the cleanup cannot settle (a leaf this user may not
 * remove, an unattested device of a member) stands: the view shows the warning.
 */
export async function withDepartedLeavesGone<T>(q: string, opts: { members: string[] | null; mayManage: boolean; noBots?: boolean }, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!isGhostRefusal(e)) throw e;
    const cleaned = await cleanupConversation(q, { members: opts.members ?? undefined, mayManage: opts.mayManage, noBots: opts.noBots, urgent: true }).catch(() => null);
    if (cleaned?.outcome !== "removed" && cleaned?.outcome !== "clean") throw e;
    return attempt();
  }
}

/**
 * After (re)connecting to `domain`: the node's pending removals of this user's own leaves; every conversation with
 * a local group is cleaned (own-user rule, any device of the user may remove them).
 */
export async function cleanupOwnLeaves(domain: string): Promise<void> {
  const mls = await getMls();
  if (!mls) return;
  let items: { conversation_id: string }[];
  try {
    items = (await apiFor(domain).mls.ownPendingRemovals()).items;
  } catch {
    return;
  }
  const conversations = new Set(items.map((i) => `${domain}/${i.conversation_id}`));
  for (const q of conversations) {
    if (mls.hasGroup(q)) await cleanupConversation(q, { members: null, mayManage: false }).catch(() => null);
  }
}
