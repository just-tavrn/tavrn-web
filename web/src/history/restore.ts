// SPDX-License-Identifier: Apache-2.0
/**
 * History restore after a key reset (protocol ENCRYPTION.md §7b "History after a key reset"): the requester's state
 * in a room, the open requests for members with `restore_history`, the realtime events and the approval, which is the
 * key share itself: this device sends the requester's keys of every encrypted channel it can read.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { qualify } from "@tavrn/e2ee";
import type { HistoryRequest, HistoryRequestChannel, TavrnApi } from "@tavrn/sdk";
import { t as translate } from "../i18n";
import { roomPath } from "../components/NodeScope";
import { historyRestore, historyRestorePlan } from "../crypto/history";
import { filesChannelRoom, registerFilesChannel } from "../files/registry";
import { useNotifications } from "../stores/notifications";
import { useToasts } from "../stores/toasts";
import { useCapabilities } from "../moderation/hooks";

export const RESTORE_CAPABILITY = "history.restore";

export const restoreKeys = {
  mine: (node: string | null, roomId: string) => ["history-mine", node ?? "", roomId] as const,
  requests: (node: string | null, roomId: string) => ["history-requests", node ?? "", roomId] as const,
};

/** Does the node hosting the room implement the restore (capability `history.restore`)? */
export function useRestoreSupported(node: string | null): boolean {
  return !!useCapabilities(node)?.includes(RESTORE_CAPABILITY);
}

/** The requester's own state in the room (its key reset, an approved restore, its latest request). */
export function useMyRestoreState(client: TavrnApi, node: string | null, roomId: string | null | undefined, enabled = true) {
  const supported = useRestoreSupported(node);
  return useQuery({
    queryKey: restoreKeys.mine(node, roomId ?? ""),
    queryFn: () => client.historyRequests.mine(roomId!),
    enabled: enabled && supported && !!roomId,
    staleTime: 60_000,
  });
}

/** The room's open requests (members with `restore_history`). */
export function useRestoreRequests(client: TavrnApi, node: string | null, roomId: string, enabled: boolean) {
  const supported = useRestoreSupported(node);
  return useQuery({
    queryKey: restoreKeys.requests(node, roomId),
    queryFn: () => client.historyRequests.list(roomId),
    enabled: enabled && supported,
    staleTime: 30_000,
  });
}

/** A request's channel as the e2ee layer takes it. */
export function restoreChannel(c: HistoryRequestChannel): { kind: string; windowStart: number | null } {
  const start = c.window_start ? Date.parse(c.window_start) : NaN;
  return { kind: c.kind, windowStart: Number.isFinite(start) ? start : null };
}

export interface ChannelPlan {
  channelId: string;
  epochs: number;
  /** First and last epoch this device would send. */
  first: number | null;
  last: number | null;
  missing: number;
  unknown: boolean;
}

/**
 * Runs `fn` on the channel's qualified id; a files channel is known with its room meanwhile, so that the key checks
 * read its entry records (FILES.md §8.7) exactly as they read a text channel's messages.
 */
async function withFilesRoom<T>(domain: string, roomId: string, c: HistoryRequestChannel, fn: (q: string) => Promise<T>): Promise<T> {
  const q = qualify(domain, c.channel_id);
  // An open files view registered it already (and keeps it registered).
  const release = c.kind === "files" && !filesChannelRoom(q) ? registerFilesChannel(q, roomId) : () => undefined;
  try {
    return await fn(q);
  } finally {
    release();
  }
}

/** What this device would share for each channel of a request (shown before approving). */
export async function planRestore(domain: string, request: HistoryRequest): Promise<ChannelPlan[]> {
  const out: ChannelPlan[] = [];
  for (const c of request.channels) {
    const plan = await withFilesRoom(domain, request.room_id, c, (q) => historyRestorePlan(q, restoreChannel(c)));
    out.push({ channelId: c.channel_id, epochs: plan.epochs.length, first: plan.epochs[0] ?? null, last: plan.epochs[plan.epochs.length - 1] ?? null, missing: plan.missing, unknown: plan.unknown });
  }
  return out;
}

/** The plan is partial when a channel lacks epochs or cannot be told. */
export function isPartial(plans: ChannelPlan[]): boolean {
  return plans.some((p) => p.missing > 0 || p.unknown);
}

export interface RestoreResult {
  channels: number;
  shared: number;
  partial: number;
  skipped: number;
}

/** After the approval: the restore shares from this device, channel by channel. */
export async function shareRestore(domain: string, request: HistoryRequest): Promise<RestoreResult> {
  const result: RestoreResult = { channels: request.channels.length, shared: 0, partial: 0, skipped: 0 };
  for (const c of request.channels) {
    try {
      const r = await withFilesRoom(domain, request.room_id, c, (q) => historyRestore(q, request.user, restoreChannel(c)));
      if (r.skipped) result.skipped++;
      else {
        result.shared++;
        if (r.missing > 0 || r.unknown) result.partial++;
      }
    } catch {
      result.skipped++;
    }
  }
  return result;
}

interface RequestEvent {
  room_id: string;
  request: HistoryRequest;
}

/** `history.request` on the socket of `node` (null = home node): the list refreshes and the approvers are notified. */
export function historyRequestEvent(d: RequestEvent, node: string | null, queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: restoreKeys.requests(node, d.room_id) });
  const name = d.request.display_name || d.request.user;
  const title = translate("history_restore.notify_title");
  const body = translate("history_restore.notify_body", { name });
  const path = roomPath(node, d.room_id, undefined, "settings/history");
  useNotifications.getState().push({ kind: "history", title, body, path });
  useToasts.getState().push({ kind: "info", title, detail: body, path, testId: "history-request-toast" });
}

/**
 * `history.request_decided`: the requester's state and the approvers' list refresh; after an approval the cut is
 * lifted, so the loaded message pages of the room's channels are fetched again.
 */
export function historyDecidedEvent(d: RequestEvent, node: string | null, queryClient: QueryClient, me: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: restoreKeys.requests(node, d.room_id) });
  void queryClient.invalidateQueries({ queryKey: restoreKeys.mine(node, d.room_id) });
  if (!me || d.request.user !== me) return;
  if (d.request.status === "approved") {
    void queryClient.invalidateQueries({ queryKey: ["messages"] });
    useToasts.getState().push({ kind: "info", title: translate("history_restore.approved_toast", { by: d.request.decided_by ?? "" }), testId: "history-decided-toast" });
  } else if (d.request.status === "denied") {
    useToasts.getState().push({ kind: "warning", title: translate("history_restore.denied_toast", { by: d.request.decided_by ?? "" }), detail: d.request.reason ?? undefined, testId: "history-decided-toast" });
  }
}
