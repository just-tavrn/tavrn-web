// SPDX-License-Identifier: Apache-2.0
/**
 * History for new members of encrypted channels (ENCRYPTION.md §7b) in the web client: one
 * {@link HistorySync} per session manager, fed by the realtime events (`history.pending`,
 * `history.keys_available`, own Adds) and by opening a channel. Keys go straight from the share into the
 * MLS client state (the encrypted key store and the history backup); nothing here keeps or logs them.
 */
import { HistorySync, type HistoryPolicy, type MlsManager, type RestoreChannel, type RestorePlan } from "@tavrn/e2ee";
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
        messages: (c, q) => a.conversations.messages(c, q),
      };
    },
    isOnline: (address) => address === user.address || !!usePresence.getState().users[address],
    resetAt: identityResetAt,
    // TODO(files-e2ee): files channels with a window start: the oldest record epoch from `GET records?since=` (FILES.md
    // §8.7) once FilesView decrypts records; until then such channels are restored only for a window without start.
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
}
