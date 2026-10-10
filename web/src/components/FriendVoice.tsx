// SPDX-License-Identifier: Apache-2.0
/**
 * Where a friend is in voice (docs/CLIENT.md "Voice activity in the room rail and the friends list"): the room and
 * channel under the friend in the friends list and a "Join <channel>" entry in the friend's menu. Only rooms the user
 * is a member of (the room lists of the home node and of the nodes with a session) and only channels in the presence
 * store, which holds the channels the node lets the user view: a friend in a hidden channel or a foreign room shows
 * nothing at all. Joining goes the way of the channel list (`joinVoice`, its errors as toasts).
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Permission, hasPermission, type RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { api } from "../lib/api";
import { channelName } from "../lib/names";
import { channelPermissions } from "../lib/channelPermissions";
import { useAuth } from "../stores/auth";
import { apiFor, isHome, useNodes } from "../stores/nodes";
import { roomKey } from "../stores/railFolders";
import { useUnread } from "../stores/unread";
import { toastError } from "../stores/toasts";
import { useVoicePresence } from "../voice/presence";
import { voiceLocationOf } from "../voice/roomActivity";
import { ownVoiceChannel, useVoice } from "../voice/store";
import { joinVoice } from "../voice";
import { SpeakerIcon } from "../voice/ui/icons";
import { roomPath } from "./NodeScope";

/** A friend's voice location with the names to show and how to join. */
export interface FriendVoice {
  roomName: string;
  channelName: string;
  join: () => Promise<void>;
}

/** The rooms the user is a member of, by room key, with their node (null: home) and name. */
function useMemberRooms(): Map<string, { node: string | null; name: string }> {
  const homeDomain = useAuth((s) => s.user?.domain ?? "");
  const home = useQuery({ queryKey: ["rooms"], queryFn: () => api.rooms.list() });
  const domains = useNodes((s) => Object.keys(s.sessions).sort().join(","));
  const list = domains ? domains.split(",").filter((d) => d !== homeDomain) : [];
  const remote = useQueries({ queries: list.map((d) => ({ queryKey: ["rooms", d], queryFn: () => apiFor(d).rooms.list(), retry: 1 })) });
  const rooms = new Map<string, { node: string | null; name: string }>();
  for (const r of home.data ?? []) rooms.set(roomKey(homeDomain, r.id), { node: null, name: r.name });
  list.forEach((d, i) => {
    for (const r of remote[i]?.data ?? []) rooms.set(roomKey(d, r.id), { node: d, name: r.name });
  });
  return rooms;
}

/** The room detail (the cache entry of the sidebar and the rail), loaded while a friend is in one of its channels. */
function detailQuery(node: string | null, roomId: string) {
  return {
    queryKey: ["room", roomId],
    queryFn: async (): Promise<RoomDetail> => {
      const r = await apiFor(node).rooms.get(roomId);
      useUnread.getState().seed(r.read_states ?? []);
      return r;
    },
    staleTime: 30_000,
  };
}

/** Where `address` is in voice, or null (see the module comment). */
export function useFriendVoice(address: string): FriendVoice | null {
  const t = useT();
  const rooms = useMemberRooms();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const keys = new Set(rooms.keys());
  // A string keeps the selector stable.
  const found = useVoicePresence((s) => {
    const l = voiceLocationOf(s, address, keys);
    return l ? `${l.domain}\n${l.roomId}\n${l.channelId}` : "";
  });
  const [domain = "", roomId = "", channelId = ""] = found ? found.split("\n") : [];
  const room = found ? rooms.get(roomKey(domain, roomId)) : undefined;
  const node = room?.node ?? null;
  const detail = useQuery({ ...detailQuery(node, roomId), enabled: !!room });
  if (!found || !room) return null;
  const channel = detail.data?.channels.find((c) => c.id === channelId);
  const name = channel ? channelName(channel) : t("rail.card.voice_channel");
  const join = async () => {
    try {
      const d = detail.data ?? (await queryClient.fetchQuery(detailQuery(node, roomId)));
      if (!d) return;
      const me = isHome(node) ? useAuth.getState().user?.id : useNodes.getState().sessions[node!]?.user.id;
      const perms = channelPermissions(d, channelId, me ?? "", ownVoiceChannel(useVoice.getState(), domain, roomId));
      navigate(roomPath(node, roomId, channelId));
      const connected = useVoice.getState().status !== "idle" && useVoice.getState().target?.domain === domain && useVoice.getState().target?.channelId === channelId;
      if (!connected) await joinVoice({ domain, roomId, channelId }, { canCreate: hasPermission(perms, Permission.SEND_MESSAGES) });
    } catch (e) {
      toastError(e);
    }
  };
  return { roomName: room.name, channelName: name, join };
}

/** The line under a friend: speaker, room and channel. */
export function FriendVoiceLine({ voice }: { voice: FriendVoice }) {
  const t = useT();
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-ok" data-testid="friend-voice">
      <SpeakerIcon size={14} />
      <span className="truncate">{t("friends.in_voice", { room: voice.roomName, channel: voice.channelName })}</span>
    </p>
  );
}
