// SPDX-License-Identifier: Apache-2.0
/**
 * History for new members of encrypted channels (ENCRYPTION.md §7b) in the web client: one
 * {@link HistorySync} per session manager, fed by the realtime events (`history.pending`,
 * `history.keys_available`, own Adds) and by opening a channel. Keys go straight from the share into the
 * MLS client state (the encrypted key store and the history backup); nothing here keeps or logs them.
 */
import { HistorySync, type HistoryPolicy, type MlsManager } from "@tavrn/e2ee";
import { getMls } from "../stores/mls";
import { useAuth } from "../stores/auth";
import { apiFor } from "../stores/nodes";
import { usePresence } from "../stores/presence";

let current: { mls: MlsManager; sync: HistorySync } | null = null;

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

/** Sign-out or lock: stop pending timers. */
export function resetHistory(): void {
  current?.sync.dispose();
  current = null;
}
