// SPDX-License-Identifier: Apache-2.0
/**
 * Realtime events of a room's metadata (PROTOCOL.md §6) and what they do to the query cache. The payloads carry the
 * changed objects, so the cached room detail is patched in place (lib/roomCache.ts) instead of refetched: an admin
 * action costs its own request and nothing more. The room is refetched (coalesced and debounced per room) only when
 * the viewer's own room permissions can change: role events, the viewer's own membership, the ownership. Channels
 * and categories the viewer gains or loses through any change arrive as their own `channel.*` / `category.*` events
 * (the node's per-connection visibility). The room list follows `room.update`, `room.delete` and the viewer's own
 * joins and leaves; the command palettes follow the events that change permissions.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Category, Channel, Member, PermissionOverride, Role, Room, TavrnSocket, User } from "@tavrn/sdk";
import { patchRoom, roomRefetcher, withCategory, withChannel, withOverrides, withRole, withRoom, withoutCategory, withoutChannel, withoutRole } from "../lib/roomCache";

/** Debounce of the room refetch: a burst of changes (a role reorder, a bot's setup) costs one request. */
export const ROOM_REFETCH_DELAY_MS = 250;

interface Removed {
  room_id: string;
  id: string;
}

interface OverridesChanged {
  room_id: string;
  target_type?: string;
  target_id?: string;
  overrides?: PermissionOverride[];
}

interface MembershipEvent {
  room_id: string;
  user_id?: string;
  user?: Pick<User, "id">;
  member?: Pick<Member, "user">;
}

export function roomEventHandlers(socket: TavrnSocket, queryClient: QueryClient, me: () => { id: string } | null): Array<() => void> {
  const refetch = roomRefetcher(queryClient, ROOM_REFETCH_DELAY_MS);
  const rooms = () => void queryClient.invalidateQueries({ queryKey: ["rooms"] });
  // Application commands (APPLICATIONS.md §5.4): the palettes follow definitions and the permissions of the viewer.
  const commands = () => void queryClient.invalidateQueries({ queryKey: ["commands"] });
  const own = (d: MembershipEvent) => {
    const id = d.user_id ?? d.user?.id ?? d.member?.user?.id;
    // Without a user the event may concern the viewer.
    return !id || id === me()?.id;
  };
  return [
    socket.on<Channel>("channel.create", (c) => patchRoom(queryClient, c.room_id, withChannel(c))),
    socket.on<Channel>("channel.update", (c) => patchRoom(queryClient, c.room_id, withChannel(c))),
    socket.on<Removed>("channel.delete", (d) => patchRoom(queryClient, d.room_id, withoutChannel(d.id))),
    socket.on<Category>("category.create", (c) => patchRoom(queryClient, c.room_id, withCategory(c))),
    socket.on<Category>("category.update", (c) => patchRoom(queryClient, c.room_id, withCategory(c))),
    socket.on<Removed>("category.delete", (d) => patchRoom(queryClient, d.room_id, withoutCategory(d.id))),
    socket.on<OverridesChanged>("override.update", (d) => {
      if (d.target_type && d.target_id && Array.isArray(d.overrides)) patchRoom(queryClient, d.room_id, withOverrides(d.target_type, d.target_id, d.overrides));
      else refetch.schedule(d.room_id);
      commands();
    }),
    // A role's permissions or position can change the viewer's `my_permissions` (computed by the node).
    ...["role.create", "role.update"].map((type) =>
      socket.on<Role>(type, (r) => {
        patchRoom(queryClient, r.room_id, withRole(r));
        refetch.schedule(r.room_id);
        commands();
      }),
    ),
    socket.on<Removed>("role.delete", (d) => {
      patchRoom(queryClient, d.room_id, withoutRole(d.id));
      refetch.schedule(d.room_id);
      commands();
    }),
    socket.on<Room>("room.update", (r) => {
      // `room.update` carries the room without the viewer's fields: a new owner changes them.
      const owner = queryClient.getQueryData<{ owner_id?: string }>(["room", r.id])?.owner_id;
      patchRoom(queryClient, r.id, withRoom(r));
      if (owner !== undefined && r.owner_id !== undefined && owner !== r.owner_id) refetch.schedule(r.id);
      rooms();
    }),
    socket.on<{ id: string }>("room.delete", rooms),
    socket.on<MembershipEvent>("member.update", (d) => {
      if (own(d)) refetch.schedule(d.room_id);
      commands();
    }),
    // The member count; the viewer's own joins and leaves (other devices, kicks, bans) change the room list.
    ...["member.join", "member.leave"].map((type) =>
      socket.on<MembershipEvent>(type, (d) => {
        if (own(d)) rooms();
        if (d.room_id) refetch.schedule(d.room_id);
      }),
    ),
    socket.on("commands.update", commands),
    refetch.stop,
  ];
}
