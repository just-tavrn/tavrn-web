// SPDX-License-Identifier: Apache-2.0
/**
 * History for new members of encrypted channels (ENCRYPTION.md §7b) in the web client: one
 * {@link HistorySync} per session manager, fed by the realtime events (`history.pending`,
 * `history.keys_available`, own Adds) and by opening a channel. Keys go straight from the share into the
 * MLS client state (the encrypted key store and the history backup); nothing here keeps or logs them.
 */
import { HistorySync, recordSamples, type HistoryPolicy, type MlsManager, type RestoreChannel, type RestorePlan } from "@tavrn/e2ee";
import { ulidTime, type Message, type TavrnApi } from "@tavrn/sdk";
import { filesChannelRoom } from "../files/registry";
import { getMls } from "../stores/mls";
import { useAuth } from "../stores/auth";
import { apiFor, homeKeys } from "../stores/nodes";
import { usePresence } from "../stores/presence";

let current: { mls: MlsManager; sync: HistorySync } | null = null;

/** `identity_reset_at` per address from the home node's keys document, cached for five minutes. */
const resets = new Map<string, { at: number; value: Promise<number | null> }>();
const RESET_TTL_MS = 5 * 60_000;

/**
 * The last identity reset of `address` (ENCRYPTION.md §2.3): with nodes that do not report `key_reset_at`, a member
 * reset after its join gets automatic history shares only from the reset on (§7b "History after a key reset").
 */
export function identityResetAt(address: string, now = Date.now()): Promise<number | null> {
  const hit = resets.get(address);
  if (hit && now - hit.at < RESET_TTL_MS) return hit.value;
  const value = homeKeys(address)
    .then((k) => {
      const t = k.identity_reset_at ? Date.parse(k.identity_reset_at) : NaN;
      return Number.isFinite(t) ? t : null;
    })
    .catch(() => null);
  resets.set(address, { at: now, value });
  return value;
}

/** Whether node `domain` announces `history.shares2` (cached for ten minutes; unknown or failing: no). */
const shares2Cache = new Map<string, { at: number; value: Promise<boolean> }>();
const CAPS_TTL_MS = 10 * 60_000;

export function nodeHasShares2(domain: string, now = Date.now()): Promise<boolean> {
  const hit = shares2Cache.get(domain);
  if (hit && now - hit.at < CAPS_TTL_MS) return hit.value;
  const value = apiFor(domain)
    .node.info()
    .then((info) => !!info.capabilities?.includes("history.shares2"))
    .catch(() => false);
  shares2Cache.set(domain, { at: now, value });
  return value;
}

/**
 * The entry records of a files channel as message-shaped key samples, oldest first (FILES.md §8.7): by `epoch`, or
 * from a time on (`after` as a ULID floor or `since` in milliseconds). `before` cannot be answered from records (the
 * listing only ascends): it throws, so that a reset-aware share without `min_epoch` sends nothing rather than too much.
 */
export async function fileRecordSamples(
  a: TavrnApi,
  room: string,
  c: string,
  q: { limit?: number; after?: string; before?: string; epoch?: number; since?: number },
): Promise<Message[]> {
  if (q.before !== undefined) throw new Error("records cannot be listed backwards");
  const fromMs = q.since ?? (q.after !== undefined ? ulidTime(q.after) : null);
  if (q.epoch === undefined && fromMs === null) return [];
  const since = fromMs !== null && fromMs > 0 ? new Date(fromMs).toISOString() : undefined;
  const { entries } = await a.files.records(room, c, { epoch: q.epoch, since, limit: q.limit });
  return recordSamples(entries) as unknown as Message[];
}

async function historySync(): Promise<HistorySync | null> {
  const mls = await getMls();
  const { user, deviceId } = useAuth.getState();
  if (!mls || !user || !deviceId) return null;
  if (current?.mls === mls) return current.sync;
  current?.sync.dispose();
  const sync = new HistorySync({
    mls,
    address: user.address,
    deviceId,
    api: (domain) => {
      const a = apiFor(domain);
      return {
        share: (c, req) => a.history.share(c, req),
        shares: (c) => a.history.shares(c),
        ack: (c, id) => a.history.ack(c, id),
        pending: (c) => a.history.pending(c),
        // Files channels have no messages: entry records stand in for them (FILES.md §8.7), for the key checks and the
        // reset-aware windows alike (ENCRYPTION.md §7b).
        messages: async (c, q) => {
          const room = filesChannelRoom(`${domain}/${c}`);
          return room ? fileRecordSamples(a, room, c, q) : a.conversations.messages(c, q);
        },
      };
    },
    isOnline: (address) => address === user.address || !!usePresence.getState().users[address],
    resetAt: identityResetAt,
    // Shares sealed per recipient device where the hosting node supports them (ENCRYPTION.md §7b "Format v2").
    shares2: nodeHasShares2,
    // Files channels with a window start: the oldest record epoch since then (`GET records?since=`, FILES.md §8.7).
    firstEpoch: async (q, kind, sinceMs) => {
      const slash = q.indexOf("/");
      const domain = q.slice(0, slash);
      const c = q.slice(slash + 1);
      const room = filesChannelRoom(q);
      if (kind !== "files" || slash < 0 || !room) throw new Error("unknown channel");
      const samples = await fileRecordSamples(apiFor(domain), room, c, { after: undefined, since: sinceMs, limit: 20 });
      return samples.length ? Math.min(...samples.map((m) => m.epoch as number)) : null;
    },
    // Only the kind of event: never ids, payloads or keys.
    onLog: (event) => console.warn(`tavrn: history ${event.replace("_", " ")}`),
  });
  current = { mls, sync };
  return sync;
}

/** `history.pending` or a channel opened: share with members who wait, if this device is elected. */
export function historyPending(q: string, policy: HistoryPolicy): void {
  void historySync()
    .then((s) => s?.checkPending(q, policy))
    .catch(() => undefined);
}

/** `history.keys_available` or a channel opened: fetch, check and store the shares for this user. */
export async function historyReceive(q: string): Promise<number> {
  try {
    return (await (await historySync())?.receive(q)) ?? 0;
  } catch {
    return 0;
  }
}

/** This device committed Adds (MlsEvent `added`): it shares with these users first. */
export function historyAdded(q: string, addresses: string[]): void {
  void historySync()
    .then((s) => s?.noteAdded(q, addresses))
    .catch(() => undefined);
}

/** What this device can restore of a requester's window in `q` (after a key reset, ENCRYPTION.md §7b). */
export async function historyRestorePlan(q: string, channel: RestoreChannel): Promise<RestorePlan> {
  try {
    return (await (await historySync())?.restorePlan(q, channel)) ?? { epochs: [], missing: 0, unknown: true };
  } catch {
    return { epochs: [], missing: 0, unknown: true };
  }
}

/** After approving a restore request: sends the requester's keys of `q` from this device. */
export async function historyRestore(q: string, to: string, channel: RestoreChannel): Promise<RestorePlan & { sent: number; skipped: boolean }> {
  const sync = await historySync();
  if (!sync) return { epochs: [], missing: 0, unknown: true, sent: 0, skipped: true };
  return sync.restore(q, to, channel);
}

/** Sign-out or lock: stop pending timers. */
export function resetHistory(): void {
  current?.sync.dispose();
  current = null;
  resets.clear();
  shares2Cache.clear();
}
