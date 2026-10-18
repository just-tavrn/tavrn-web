// SPDX-License-Identifier: Apache-2.0
/**
 * Voice events of every node socket (VOICE.md §5, §7, §8, §11): `voice.state` feeds the presence store,
 * `voice.move` moves the own call (and the view, `moveFollow.ts`), `soundboard.update` refreshes the clip lists; deletions and the own
 * removal from a room end the call; `call.ring`/`call.update`/`call.end` drive calls in DMs. Kept apart from `useRealtime` so the voice client stays one module.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { TavrnApiError, type Member, type RoomDetail, type TavrnSocket, type VoiceChannelState } from "@tavrn/sdk";
import { splitIdentity } from "@tavrn/e2ee";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { useAuth } from "../stores/auth";
import { apiFor, useNodes } from "../stores/nodes";
import { fetchRoomMembers } from "../pages/ChannelPage";
import { priorityAllowed, setPriorityVerifier } from "./priority";
import { soundboardAllowed, setSoundboardVerifier } from "./soundboardAuthorization";
import { useNode } from "../components/NodeScope";
import { useVoicePresence } from "./presence";
import { useVoice } from "./store";
import { followMove, leaveVoice } from "./index";
import { followMoveView } from "./moveFollow";
import { onEndEvent, onRingEvent, onUpdateEvent } from "./calls/actions";

/** Whether the call is in this room (or channel) of `domain`. */
function inCall(domain: string, roomId: string, channelId?: string): boolean {
  const t = useVoice.getState().target;
  return !!t && !t.call && t.domain === domain && t.roomId === roomId && (!channelId || t.channelId === channelId);
}

/** A member list is refetched for an unknown priority speaker at most this often per room. */
const MEMBER_REFRESH_MS = 10_000;

export function useVoiceRealtime() {
  const home = useRealtimeState((s) => s.socket);
  const nodes = useNodeSockets((s) => s.sockets);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Read when a move has been followed (the route may change while the rejoin runs); no resubscription per route.
  const { pathname } = useLocation();
  const route = useRef({ pathname, navigate });
  useEffect(() => {
    route.current = { pathname, navigate };
  }, [pathname, navigate]);
  useMyVoiceStates();

  // Soundboard overlays require both effective bits, even when SPEAK grants LiveKit data for whisper.
  useEffect(() => {
    setSoundboardVerifier((target, identity) => soundboardAllowed(
      queryClient.getQueryData<RoomDetail>(["room", target.roomId]),
      queryClient.getQueryData<Member[]>(["members", target.roomId]),
      target.channelId,
      splitIdentity(identity).address,
    ));
    return () => setSoundboardVerifier(null);
  }, [queryClient]);

  // Priority speaker claims (design note 4.13 item 3) are checked against the room's roles and overrides and
  // the speaker's member entry, never trusted from the LiveKit attribute alone.
  useEffect(() => {
    const refreshed = new Map<string, number>();
    setPriorityVerifier(async (target, identity) => {
      const address = splitIdentity(identity).address;
      const room = queryClient.getQueryData<RoomDetail>(["room", target.roomId]);
      let members = queryClient.getQueryData<Member[]>(["members", target.roomId]);
      const last = refreshed.get(target.roomId) ?? 0;
      if (room && !members?.some((m) => m.user.address === address) && Date.now() - last > MEMBER_REFRESH_MS) {
        refreshed.set(target.roomId, Date.now());
        members = await queryClient.fetchQuery({ queryKey: ["members", target.roomId], queryFn: () => fetchRoomMembers(apiFor(target.domain), target.roomId), staleTime: 0 });
      }
      return priorityAllowed(room, members, target.channelId, address);
    });
    return () => setPriorityVerifier(null);
  }, [queryClient]);

  useEffect(() => {
    const homeDomain = useAuth.getState().user?.domain;
    const pairs: Array<[TavrnSocket, string]> = Object.entries(nodes).map(([domain, socket]) => [socket, domain]);
    if (home && homeDomain) pairs.push([home, homeDomain]);
    /** The user as the node of `domain` knows it (user ids are node-local). */
    const me = (domain: string) => (domain === homeDomain ? useAuth.getState().user?.id : useNodes.getState().sessions[domain]?.user.id);
    const offs = pairs.flatMap(([socket, domain]) => [
      socket.on<VoiceChannelState>("voice.state", (d) => useVoicePresence.getState().apply(domain, d)),
      socket.on<{ room_id: string; from_channel_id: string; channel_id: string; user_id: string }>("voice.move", (d) => {
        void followMove(domain, d).then((followed) => {
          if (followed) void followMoveView({ domain, data: d, pathname: route.current.pathname, navigate: route.current.navigate, queryClient });
        });
      }),
      socket.on<{ room_id: string }>("soundboard.update", (d) => void queryClient.invalidateQueries({ queryKey: ["soundboard", domain, d.room_id] })),
      socket.on<{ room_id: string; id: string }>("channel.delete", (d) => {
        useVoicePresence.getState().removeChannel(domain, d.id);
        if (inCall(domain, d.room_id, d.id)) void leaveVoice();
      }),
      socket.on<{ id: string }>("room.delete", (d) => {
        useVoicePresence.getState().clearRoom(domain, d.id);
        if (inCall(domain, d.id)) void leaveVoice();
      }),
      socket.on<{ room_id: string; user_id: string }>("member.leave", (d) => {
        if (d.user_id === me(domain) && inCall(domain, d.room_id)) void leaveVoice();
      }),
      // Calls in DMs and group DMs (VOICE.md §11); rings of other nodes' conversations come via the home node.
      socket.on<Parameters<typeof onRingEvent>[1]>("call.ring", (d) => onRingEvent(domain, d)),
      socket.on<Parameters<typeof onUpdateEvent>[1]>("call.update", (d) => onUpdateEvent(domain, d)),
      socket.on<Parameters<typeof onEndEvent>[1]>("call.end", (d) => onEndEvent(domain, d)),
    ]);
    return () => offs.forEach((off) => off());
  }, [home, nodes, queryClient]);
}

/** Query key of a node's `GET /users/me/voice` (invalidated on `ready` and resyncs of that node's socket). */
export const myVoiceKey = (domain: string) => ["my-voice", domain] as const;

/**
 * Initial voice presence of every room the user is in (`GET /users/me/voice`, VOICE.md §5), of the home node and of
 * every node with a federated session, for the room rail and the friends list; `voice.state` keeps it current and the
 * sockets refetch it after `ready` and a resync (`useRealtime`). Nodes without the route (404) keep the per-room
 * snapshots of opened rooms.
 */
function useMyVoiceStates() {
  const homeDomain = useAuth((s) => s.user?.domain);
  const remote = useNodes((s) => Object.keys(s.sessions).sort().join(","));
  const domains = [...new Set([homeDomain, ...remote.split(",")].filter((d): d is string => !!d))];
  useQueries({
    queries: domains.map((domain) => ({
      queryKey: myVoiceKey(domain),
      queryFn: async () => {
        try {
          const { rooms } = await apiFor(domain).voice.mine();
          useVoicePresence.getState().seedAll(domain, rooms);
          return rooms.length;
        } catch (e) {
          if (e instanceof TavrnApiError && e.status === 404) return 0;
          throw e;
        }
      },
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: 1,
    })),
  });
}

/** Initial voice presence of a room (`GET …/voice`), refreshed on reconnects of the node's socket. */
export function useRoomVoiceStates(roomId: string, enabled = true) {
  const { api, domain } = useNode();
  return useQuery({
    queryKey: ["voice-states", domain, roomId],
    queryFn: async () => {
      const { items } = await api.voice.roomStates(roomId);
      useVoicePresence.getState().seedRoom(domain, roomId, items);
      return items;
    },
    enabled: enabled && !!roomId,
    staleTime: 30_000,
    retry: 1,
  });
}

/** The room's soundboard clips (members). */
export function useSoundboard(roomId: string, enabled = true) {
  const { api, domain } = useNode();
  return useQuery({ queryKey: ["soundboard", domain, roomId], queryFn: () => api.soundboard.list(roomId), enabled: enabled && !!roomId, staleTime: 60_000 });
}
