// SPDX-License-Identifier: Apache-2.0
/** Shared queries of the moderation features (protocol MODERATION.md): node capabilities and open report counts. */
import { useQuery } from "@tanstack/react-query";
import type { TavrnApi } from "@tavrn/sdk";
import { apiFor } from "../stores/nodes";
import { nodeInfoQuery } from "../lib/queries";

/** Capabilities of a node (`null` = home node); the same cache entry as the other `GET /node` reads. */
export function useCapabilities(node: string | null): readonly string[] | undefined {
  const client = apiFor(node);
  const info = useQuery(nodeInfoQuery(node ?? null, client));
  return info.data?.capabilities;
}

/** Query keys of the inbox: everything under `["reports"]` is refreshed by `report.*` events. */
export const reportKeys = {
  room: (node: string | null, roomId: string) => ["reports", node ?? "", "room", roomId] as const,
  admin: () => ["reports", "", "admin"] as const,
  detail: (node: string | null, id: string) => ["reports", node ?? "", "detail", id] as const,
};

/** Open reports of a room's inbox (badge), or null while unknown or not allowed. */
export function useOpenRoomReports(client: TavrnApi, node: string | null, roomId: string, enabled: boolean): number | null {
  const q = useQuery({
    queryKey: [...reportKeys.room(node, roomId), "open-count"],
    queryFn: () => client.reports.room(roomId, { status: "open", limit: 1 }),
    enabled,
    staleTime: 60_000,
  });
  return q.data?.open ?? null;
}

/** Open reports of the node (admin badge). */
export function useOpenAdminReports(client: TavrnApi, enabled: boolean): number | null {
  const q = useQuery({ queryKey: [...reportKeys.admin(), "open-count"], queryFn: () => client.reports.admin({ status: "open", limit: 1 }), enabled, staleTime: 60_000 });
  return q.data?.open ?? null;
}

/** A small count badge (nothing for 0). */
export function badgeText(n: number | null | undefined): string | null {
  if (!n) return null;
  return n > 99 ? "99+" : String(n);
}
