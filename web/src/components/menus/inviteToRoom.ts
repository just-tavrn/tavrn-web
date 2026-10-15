// SPDX-License-Identifier: Apache-2.0
/**
 * "Invite to room" in the friend and member menus: the user's rooms on every node with a session, their
 * permissions from the room details (the same cache entries as the sidebar and the room menu, loaded when a menu
 * opens), and the direct invite (FEDERATION.md §3.4) that puts the invitation into the target's invite list.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { parsePermissions, type Member } from "@tavrn/sdk";
import { t } from "../../i18n";
import type { InviteRoomCandidate } from "../../lib/menus";
import { apiFor, homeDomain, useNodes } from "../../stores/nodes";
import { toastError, useToasts } from "../../stores/toasts";
import { useUnread } from "../../stores/unread";
import { roomsQuery } from "../../lib/queries";

/** At most this many rooms per node get their detail loaded for the menu (like the notification preload). */
const MAX_ROOMS_PER_NODE = 50;

/** The user's rooms with what the menu needs; loads the lists and details only while `enabled` (an open menu). */
export function useInviteRooms(enabled: boolean): InviteRoomCandidate[] {
  const queryClient = useQueryClient();
  const home = homeDomain() ?? "";
  const domains = useNodes((s) => Object.keys(s.sessions).filter((d) => d !== home).sort().join(","));
  // Nothing is observed while the menu is closed (one hook per member row).
  const remote = enabled && domains ? domains.split(",") : [];
  const homeRooms = useQuery({ ...roomsQuery(null), enabled });
  const remoteRooms = useQueries({ queries: remote.map((d) => ({ ...roomsQuery(d), enabled })) });
  const rooms = !enabled ? [] : [
    ...(homeRooms.data ?? []).slice(0, MAX_ROOMS_PER_NODE).map((r) => ({ id: r.id, name: r.name, node: null as string | null })),
    ...remoteRooms.flatMap((q, i) => (q.data ?? []).slice(0, MAX_ROOMS_PER_NODE).map((r) => ({ id: r.id, name: r.name, node: remote[i]! as string | null }))),
  ];
  const details = useQueries({
    queries: rooms.map((r) => ({
      queryKey: ["room", r.id],
      queryFn: async () => {
        const room = await apiFor(r.node).rooms.get(r.id);
        useUnread.getState().seed(room.read_states ?? []);
        return room;
      },
      staleTime: 30_000,
      retry: 1,
    })),
  });
  return rooms.map((r, i) => {
    const room = details[i]?.data;
    const members = queryClient.getQueryData<Member[]>(["members", r.id]);
    return {
      id: r.id,
      name: room?.name ?? r.name,
      node: r.node,
      perms: room ? parsePermissions(room.my_permissions) : null,
      isOwner: !!room?.is_owner,
      members: Array.isArray(members) ? members.map((m) => m.user.address) : null,
    };
  });
}

/**
 * Sends a direct invite for `address` into `room` and reports the outcome as a toast: "Invitation sent" or the
 * node's refusal (already a member, banned, the rate limit) in its own words.
 */
export async function sendRoomInvite(room: Pick<InviteRoomCandidate, "id" | "name" | "node">, address: string, name: string): Promise<boolean> {
  try {
    await apiFor(room.node).invites.direct(room.id, address);
    useToasts.getState().push({ kind: "info", title: t("menu.invite_room_sent", { room: room.name, name }) });
    return true;
  } catch (e) {
    // `room.banned` here means the invitee (the generic text speaks of the user themselves).
    if ((e as { problem?: { code?: string } }).problem?.code === "room.banned") useToasts.getState().push({ kind: "error", title: t("menu.invite_room_failed"), detail: t("menu.invite_room_banned") });
    else toastError(e, t("menu.invite_room_failed"));
    return false;
  }
}
