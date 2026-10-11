// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { TavrnSocket, type Conversation, type EphemeralReply, type FriendRequest, type Message, type PendingInvite, type Presence, type RoomDetail, type SocketStatus, type User } from "@tavrn/sdk";
import { create } from "zustand";
import { refreshHome, wsUrl } from "../lib/api";
import { cleanupConversation, cleanupOwnLeaves } from "../lib/leafCleanup";
import { useAuth } from "../stores/auth";
import { useToasts } from "../stores/toasts";
import { t } from "../i18n";
import { useTyping } from "../stores/typing";
import { useInteractions } from "../stores/interactions";
import { api } from "../lib/api";
import { getMls, ownIdentityRotated, resetMls, useMlsUi } from "../stores/mls";
import { e2eeContext, useE2ee } from "../stores/e2ee";
import { forgetIdentityKeepDevice, syncIdentity } from "../crypto/e2ee";
import { cryptoStore } from "../crypto/store";
import { ownIdentityChange } from "../lib/ownIdentity";
import { qualify, splitIdentity } from "@tavrn/e2ee";
import { acceptInvite, autoAccepts } from "../lib/invites";
import { mayManageRoom } from "../lib/rooms";
import { mapMessages, prependMessage, type MessagePages } from "../lib/messagePages";
import { threadHandlers, threadMessage } from "../threads/realtime";
import { useUnread } from "../stores/unread";
import { apiFor, homeDomain, refreshNode, useNodes } from "../stores/nodes";
import { loadFollowedThreads } from "../threads/loadFollowed";
import { unindexConversation, unindexMessages } from "../search/local";
import { isRealDeletion, useHiddenChannels } from "../lib/hiddenChannels";
import { usePresence } from "../stores/presence";
import { useNotifications } from "../stores/notifications";
import { isAttentive } from "./useMarkRead";
import { loadRoomDetails, notifyMessage } from "../lib/notify";
import { historyPending, historyReceive } from "../crypto/history";
import { historyDecidedEvent, historyRequestEvent } from "../history/restore";
import { registerFilesChannel, useHistoryKeys } from "../files/registry";
import { parseHistoryPolicy } from "@tavrn/e2ee";
import { alertText, reportCreated, type ModerationAlert, type ReportCreated } from "../moderation/realtime";
import { rememberDeleted } from "../moderation/deletedIds";
import { viaOf } from "../components/ViaNode";

/**
 * May this user commit removals of departed members in a conversation (`mls.remove_needed`)? DMs and group DMs:
 * every member; room channels: members who may kick, ban or manage channels. Leaves of deleted devices and the
 * user's own other leaves every member may remove (ENCRYPTION.md §4.7).
 */
export function mayManageConversation(queryClient: QueryClient, conversationId: string): boolean {
  for (const [, room] of queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] })) {
    if (room?.channels?.some((c) => c.id === conversationId)) return mayManageRoom(room);
  }
  // The conversation lists of every node (["conversations"] and ["conversations", domain]).
  return queryClient.getQueriesData<Conversation[]>({ queryKey: ["conversations"] }).some(([, list]) => !!list?.some((c) => c.id === conversationId));
}

/** The history policy of a channel whose room is cached (ENCRYPTION.md §7b); null if unknown. */
function channelHistoryPolicy(queryClient: QueryClient, conversationId: string) {
  for (const [, room] of queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] })) {
    const channel = room?.channels?.find((c) => c.id === conversationId);
    if (channel) return channel.encrypted ? parseHistoryPolicy(channel.history_for_new_members) : null;
  }
  return null;
}

/** Registers an encrypted files channel found in the cached rooms for the history key checks; returns the cleanup. */
function registerKnownFilesChannel(queryClient: QueryClient, qualified: string, conversationId: string): () => void {
  for (const [, room] of queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] })) {
    const channel = room?.channels?.find((c) => c.id === conversationId);
    if (channel?.kind === "files" && channel.encrypted) return registerFilesChannel(qualified, room!.id);
  }
  return () => undefined;
}

/** `identity.changed` of another user (of any node): re-check the key on the user's home node (notice, §3.3). */
async function contactIdentityChanged(address: string, queryClient: QueryClient) {
  const m = await getMls();
  m?.identityChanged(address);
  await m?.verifiedDevices(address).catch(() => null);
  void queryClient.invalidateQueries({ queryKey: ["messages"] });
}

/**
 * MLS events of one node's socket (ENCRYPTION.md §4.4): conversation ids are bare ULIDs of that node,
 * so they are qualified with its domain; Welcomes are fetched from that node.
 */
export function mlsHandlers(socket: TavrnSocket, queryClient: QueryClient, domain: () => string | null): Array<() => void> {
  const q = (id: string) => {
    const d = domain();
    return d ? qualify(d, id) : null;
  };
  return [
    socket.on<{ conversation_id: string }>("mls.commit", (d) => {
      const c = q(d.conversation_id);
      if (c) void getMls().then((m) => (m?.hasGroup(c) ? m.catchUp(c) : undefined)).catch(() => undefined);
    }),
    socket.on("mls.welcome", () => {
      const d = domain();
      if (d) void getMls().then((m) => m?.processWelcomes(d)).catch(() => undefined);
    }),
    // History for new members (ENCRYPTION.md §7b): share with a member who waits, or take the keys shared with us.
    socket.on<{ conversation_id: string }>("history.pending", (d) => {
      const c = q(d.conversation_id);
      const policy = channelHistoryPolicy(queryClient, d.conversation_id);
      if (c && policy) historyPending(c, policy);
    }),
    socket.on<{ conversation_id: string }>("history.keys_available", (d) => {
      const c = q(d.conversation_id);
      if (!c) return;
      // Encrypted files channels check shared keys against entry records (FILES.md §8.7): they need the room id.
      const done = registerKnownFilesChannel(queryClient, c, d.conversation_id);
      void historyReceive(c)
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["history-pending"] });
          // Entry records of files channels may open now (FILES.md §8.7).
          useHistoryKeys.getState().bump();
        })
        .finally(done);
    }),
    // A user's devices changed (FEDERATION.md §5.2): forget the cached list, the next lookup asks the home node.
    socket.on<{ user: string }>("devices.changed", (d) => void getMls().then((m) => m?.forgetDevices(d.user)).catch(() => undefined)),
    socket.on<{ conversation_id: string; identities: string[] }>("mls.remove_needed", (d) => {
      const c = q(d.conversation_id);
      if (!c) return;
      void getMls()
        .then(async (m) => {
          if (!m) return;
          // Devices or keys of these users changed: look them up again on their home nodes (§3.3).
          for (const address of new Set(d.identities.map((i) => splitIdentity(i).address))) {
            m.forgetDevices(address);
            await m.verifiedDevices(address).catch(() => null);
          }
          // Election and single flight per conversation: not every member commits the same removal.
          await cleanupConversation(c, { mayManage: mayManageConversation(queryClient, d.conversation_id) });
        })
        .catch(() => undefined);
    }),
  ];
}

/** DM and group DM events of any node's socket (PROTOCOL.md §8a). */
function conversationHandlers(socket: TavrnSocket, queryClient: QueryClient, navigate: (to: string, opts?: { replace?: boolean }) => void): Array<() => void> {
  return [
    ...["conversation.create", "conversation.update"].map((type) =>
      socket.on<{ conversation: Conversation }>(type, (d) => {
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        queryClient.setQueryData(["conversation", d.conversation.id], d.conversation);
      }),
    ),
    socket.on<{ conversation_id: string }>("conversation.leave", (d) => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.removeQueries({ queryKey: ["conversation", d.conversation_id] });
      if (useMlsUi.getState().open === d.conversation_id) navigate("/", { replace: true });
    }),
  ];
}

/**
 * `room.invite` / `conversation.invite` (FEDERATION.md §3.4, §6.1): the invite list is refreshed; a DM or
 * group DM a friend started on another node is accepted right away (federated session, index entry, the
 * Welcome waiting there), everything else waits in the invite list on the home view.
 */
export async function onInvite(invite: PendingInvite, queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["pending-invites"] });
  if (invite.kind === "conversation") {
    const friends = await queryClient.fetchQuery({ queryKey: ["friends"], queryFn: () => api.friends.list(), staleTime: 30_000 }).catch(() => null);
    if (friends && autoAccepts(invite, friends.friends.map((f) => f.user.address))) {
      try {
        await acceptInvite(invite);
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["pending-invites"] });
        void getMls().then((m) => m?.processWelcomes(invite.node)).catch(() => undefined);
        return;
      } catch {
        /* stays in the invite list */
      }
    }
  }
  const name = invite.room?.name ?? invite.conversation?.name ?? "";
  // A sender named by a node that is not their home node is not verified: the toast says "via <node>" too.
  const via = viaOf(invite);
  useToasts.getState().push({ kind: "info", title: t(invite.kind === "room" ? "invites.toast_room" : "invites.toast_conversation", { name, inviter: invite.inviter }), detail: via ? `${invite.node} · ${t("invites.via", { node: via })}` : invite.node });
}

interface RealtimeState {
  status: SocketStatus;
  socket: TavrnSocket | null;
}

/** The home node's socket. */
export const useRealtimeState = create<RealtimeState>(() => ({ status: "closed", socket: null }));

/** Sockets of the other nodes with a session (one per node, design note 4.4). */
export const useNodeSockets = create<{ sockets: Record<string, TavrnSocket> }>(() => ({ sockets: {} }));

interface PurgeData {
  conversation_ids: string[];
  author_id?: string | null;
  from?: string | null;
  to?: string | null;
}

/**
 * Realtime events of rooms and messages, shared by the home node's socket and the sockets of other
 * nodes. `me` is the user as that node knows it (user ids are node-local).
 */
export function roomHandlers(socket: TavrnSocket, queryClient: QueryClient, me: () => { id: string; address: string } | null, node: string | null = null): Array<() => void> {
  /** Updates the loaded pages of a conversation if it is open (closed ones have no cache entry). */
  const updatePages = (conversationId: string, fn: (d: MessagePages<Message> | undefined) => MessagePages<Message> | undefined) => {
    // The channel's pages and those of its open threads (PROTOCOL.md §7e).
    for (const query of queryClient.getQueryCache().findAll({ queryKey: ["messages", conversationId] })) {
      if (query.state.data) queryClient.setQueryData<MessagePages<Message>>(query.queryKey, fn);
      // Still loading the first page: load again so that the change is not lost.
      else void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
    }
  };
  /** Qualified id of a conversation of this node (the local search index names conversations so). */
  const qualified = (conversationId: string) => qualify(node ?? homeDomain() ?? "", conversationId);
  const invalidateRoom = (data: { room_id?: string }) => {
    if (data.room_id) void queryClient.invalidateQueries({ queryKey: ["room", data.room_id] });
    // Prefix match: the home list ["rooms"] and the lists of other nodes ["rooms", domain].
    void queryClient.invalidateQueries({ queryKey: ["rooms"] });
  };
  return [
    socket.on<Message>("message.create", (m) => {
      const self = me();
      // Thread messages (PROTOCOL.md §7e): the open thread's pages; counted and notified only for followers.
      if (m.thread_id) {
        if (threadMessage(m, queryClient, self) && self) void notifyMessage(m, { queryClient, node, me: self, loadRooms: () => loadRoomDetails(queryClient, node) }).catch(() => undefined);
        return;
      }
      // Unread counts: not for the conversation the user is looking at right now.
      if (self) useUnread.getState().message(m, self, useMlsUi.getState().open === m.conversation_id && isAttentive());
      // Notifications (design note 4.11): toast, sound, notification center, browser notification.
      if (self) void notifyMessage(m, { queryClient, node, me: self, loadRooms: () => loadRoomDetails(queryClient, node) }).catch(() => undefined);
      // DMs and group DMs: refresh the list (order by last activity) unless it is a known room channel.
      const inRoom = queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] }).some(([, r]) => r?.channels?.some((c) => c.id === m.conversation_id));
      if (!inRoom) void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      // Only the open conversation has loaded pages (lazy history); nothing is fetched for others.
      updatePages(m.conversation_id, (d) => prependMessage(d, m));
      // The answer to a deferred command ends "… is thinking" (APPLICATIONS.md §5.7).
      if (m.interaction) useInteractions.getState().resolve(m.interaction.id);
    }),
    socket.on<Message>("message.update", (m) => {
      updatePages(m.conversation_id, (d) => mapMessages(d, (page) => page.map((x) => (x.id === m.id ? m : x))));
    }),
    socket.on<{ conversation_id: string; id: string }>("message.delete", (d) => {
      rememberDeleted(d.id);
      updatePages(d.conversation_id, (data) => mapMessages(data, (page) => page.filter((x) => x.id !== d.id)));
      // The local search index forgets it too (design note 4.4).
      void unindexMessages(qualified(d.conversation_id), [d.id]);
    }),
    // Content deleted with its author's account (design note 4.14 item 3): the slots stay with a placeholder, caches and
    // the local search index forget the content.
    socket.on<{ conversation_id: string; ids: string[] }>("message.redact", (d) => {
      const ids = new Set(d.ids);
      updatePages(d.conversation_id, (data) =>
        mapMessages(data, (page) => page.map((x) => (ids.has(x.id) ? { ...x, content: { type: "system.deleted" }, encrypted: false, device_id: null, signature: null, attachments: [], author_deleted: true } : x))),
      );
      void unindexMessages(qualified(d.conversation_id), d.ids);
    }),
    // An account was deleted: its messages now show "Deleted user" (the author moved to a tombstone).
    socket.on<{ user_id: string }>("user.deleted", () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      void queryClient.invalidateQueries({ queryKey: ["friends"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }),
    socket.on<PurgeData>("message.purge", (d) => {
      for (const c of d.conversation_ids) {
        // The local index cannot tell which ids went: the conversation is indexed again by the sync.
        void unindexConversation(qualified(c));
        updatePages(c, (data) =>
          mapMessages(data, (page) =>
            page.filter((m) => {
              if (d.author_id && m.author_id !== d.author_id) return true;
              if (d.from && m.created_at < d.from) return true;
              if (d.to && m.created_at > d.to) return true;
              return false;
            }),
          ),
        );
      }
    }),
    ...threadHandlers(socket, queryClient, me),
    socket.on<{ conversation_id: string; last_read_message_id: string }>("read.update", (d) => useUnread.getState().read(d.conversation_id, d.last_read_message_id)),
    // Room channels carry `channel_id`, DMs and group DMs `conversation_id`.
    socket.on<{ channel_id?: string; conversation_id?: string; user_id: string }>("typing", (d) => {
      const id = d.channel_id ?? d.conversation_id;
      if (id) useTyping.getState().mark(id, d.user_id);
    }),
    socket.on<ModerationAlert>("moderation.alert", (d) => useToasts.getState().push({ kind: "warning", title: t("automod.title"), detail: alertText(d, t) })),
    // The moderation inbox (MODERATION.md §1.5): badges and lists follow, a new report notifies.
    socket.on<ReportCreated>("report.create", (d) => reportCreated(d, node, queryClient)),
    socket.on("report.update", () => void queryClient.invalidateQueries({ queryKey: ["reports"] })),
    // History restore after a key reset (ENCRYPTION.md §7b): approvers are notified, the requester learns the decision.
    socket.on<Parameters<typeof historyRequestEvent>[0]>("history.request", (d) => historyRequestEvent(d, node, queryClient)),
    socket.on<Parameters<typeof historyDecidedEvent>[0]>("history.request_decided", (d) => historyDecidedEvent(d, node, queryClient, me()?.address)),
    socket.on<{ room_id: string; user_id: string; kicked?: boolean; banned?: boolean }>("member.leave", (d) => {
      invalidateRoom(d);
      void queryClient.invalidateQueries({ queryKey: ["members", d.room_id] });
      if (d.user_id === me()?.id && (d.kicked || d.banned)) {
        useToasts.getState().push({ kind: "warning", title: t(d.banned ? "notice.banned" : "notice.kicked") });
      }
    }),
    ...["member.join", "member.update"].map((type) => socket.on<{ room_id: string }>(type, (d) => { invalidateRoom(d); void queryClient.invalidateQueries({ queryKey: ["members", d.room_id] }); })),
    // `hidden: true`: the user lost access (PROTOCOL.md §6), the channel itself still exists.
    socket.on<{ id?: string; hidden?: boolean }>("channel.delete", (d) => {
      useHiddenChannels.getState().deleted(d);
      if (d.id && isRealDeletion(d)) void unindexConversation(qualified(d.id));
    }),
    socket.on<{ id?: string }>("channel.create", (d) => useHiddenChannels.getState().created(d.id)),
    ...["channel.create", "channel.update", "channel.delete", "category.create", "category.update", "category.delete", "role.create", "role.update", "role.delete", "override.update", "room.update"].map((type) =>
      socket.on<{ room_id?: string; id?: string }>(type, (d) => invalidateRoom({ room_id: d.room_id ?? d.id })),
    ),
    socket.on<{ room_id: string }>("emoji.update", (d) => void queryClient.invalidateQueries({ queryKey: ["emojis", d.room_id] })),
    // Application commands (APPLICATIONS.md §5.4): the palettes follow definitions, settings, roles and overrides.
    ...["commands.update", "role.create", "role.update", "role.delete", "override.update", "member.update"].map((type) =>
      socket.on(type, () => void queryClient.invalidateQueries({ queryKey: ["commands"] })),
    ),
    // An ephemeral reply for this user, from another of its connections' commands or a follow-up (§5.7).
    socket.on<EphemeralReply>("interaction.reply", (r) =>
      useInteractions.getState().add({ interactionId: r.interaction_id, conversationId: r.conversation_id, kind: "ephemeral", application: r.application, content: r.content, epoch: r.epoch, deviceId: r.device_id }),
    ),
    // ---- Profiles and presence (design note 4.9)
    socket.on<Presence>("presence.update", (p) => onPresence(p)),
    socket.on<{ user: User }>("user.update", (d) => {
      for (const key of ["members", "friends", "conversations", "conversation", "profile", "blocks", "requests"]) void queryClient.invalidateQueries({ queryKey: [key] });
      if (d.user.address === useAuth.getState().user?.address && d.user.id === useAuth.getState().user?.id) {
        const current = useAuth.getState().user;
        if (current) useAuth.getState().setUser({ ...current, ...d.user });
      }
    }),
    socket.on<{ request: { conversation: Conversation } }>("conversation.request", () => {
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
      useToasts.getState().push({ kind: "info", title: t("requests.toast") });
    }),
    socket.on<{ id: string }>("room.delete", () => void queryClient.invalidateQueries({ queryKey: ["rooms"] })),
    // An app token of one of my applications expires soon (APPLICATIONS.md §2.2).
    socket.on<{ application_id: string; token_id: string; expires_at: string; days: number }>("application.token_expiring", (d) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      useToasts.getState().push({ kind: "warning", title: t("apps.token_expiring", { days: String(d.days) }), detail: new Date(d.expires_at).toLocaleString() });
    }),
  ];
}

/** A `presence.update`: others go to the store, the own one (unfiltered view) updates `mine`. */
function onPresence(p: Presence) {
  const store = usePresence.getState();
  const me = useAuth.getState().user?.address;
  if (p.user === me) {
    if (store.mine) store.setMine({ ...store.mine, effective: p.status, custom_status: p.custom_status, activity: p.activity });
    return;
  }
  store.apply(p);
}

/** Connects the WebSocket while a token is present and keeps the query cache up to date. */
export function useRealtime() {
  // One socket per signed-in account and device; refreshed tokens do not reconnect (the socket refreshes itself).
  const session = useAuth((s) => (s.token && s.user ? `${s.user.address}/${s.deviceId ?? ""}` : null));
  const queryClient = useQueryClient();
  // `useNavigate` changes with every route change: read it through a ref, so the socket stays connected.
  const navigateNow = useNavigate();
  const navigateRef = useRef(navigateNow);
  navigateRef.current = navigateNow;
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => navigateRef.current(to, opts), []);
  const socketRef = useRef<TavrnSocket | null>(null);

  useEffect(() => {
    if (!session) return;
    const socket = new TavrnSocket({
      url: wsUrl(),
      getToken: () => useAuth.getState().token,
      capabilities: ["content.v1", "reactions", "e2ee.mls1", "commands.v1"],
      onStatus: (status) => {
        useRealtimeState.setState({ status });
        // (Re)connected: Welcomes that arrived while the socket was down, and own leaves waiting for removal.
        const home = useAuth.getState().user?.domain;
        if (status === "ready" && home) {
          // Who is in voice in every room (VOICE.md §5): events may have been missed while disconnected.
          void queryClient.invalidateQueries({ queryKey: ["my-voice", home] });
          // Followed threads of every room, so their messages count and notify before a room is opened (§7e).
          void loadFollowedThreads({ key: home, client: api, queryClient });
          void getMls()
            .then(async (m) => {
              await m?.processWelcomes(home);
              await cleanupOwnLeaves(home);
            })
            .catch(() => undefined);
        }
      },
      onResync: () => void queryClient.invalidateQueries(),
      // 4001 (expired token): one refresh, shared with the API client and the other tabs (PROTOCOL.md §5b).
      refreshToken: refreshHome,
      // Only when the node refused the session itself: network errors keep the user signed in.
      onAuthFailure: () => useAuth.getState().logout(),
    });
    socketRef.current = socket;
    useRealtimeState.setState({ socket });

    const offs = [
      ...roomHandlers(socket, queryClient, () => useAuth.getState().user),
      // ---- End-to-end encryption (ENCRYPTION.md §4.4, §4.5, §9)
      ...mlsHandlers(socket, queryClient, () => useAuth.getState().user?.domain ?? null),
      socket.on<{ user: string }>("identity.changed", (d) => void onIdentityChanged(d.user)),
      socket.on<{ user: string }>("identity.rotated", (d) => void onIdentityRotated(d.user)),
      // ---- Invitations of the invite list (FEDERATION.md §3.4, §4)
      ...["room.invite", "conversation.invite"].map((type) => socket.on<{ invite: PendingInvite }>(type, (d) => void onInvite(d.invite, queryClient))),
      // ---- Friends and conversations (PROTOCOL.md §8a)
      socket.on<{ request: FriendRequest }>("friend.request", (d) => {
        void queryClient.invalidateQueries({ queryKey: ["friends"] });
        if (d.request.direction === "incoming") useToasts.getState().push({ kind: "info", title: t("friends.toast_request"), detail: d.request.user.address });
      }),
      socket.on<{ user: User }>("friend.accept", () => void queryClient.invalidateQueries({ queryKey: ["friends"] })),
      socket.on("friend.remove", () => void queryClient.invalidateQueries({ queryKey: ["friends"] })),
      // ---- A statement of reasons about the user's content (design note 4.14 item 1)
      socket.on<{ case_id: string }>("legal.statement", (d) => notifyStatement(d.case_id, queryClient)),
      ...conversationHandlers(socket, queryClient, navigate),
    ];

    /**
     * `identity.rotated` (ENCRYPTION.md §9a): another user's key is re-checked (pinned softly with a valid continuity
     * statement); our own rotation on another device is followed (the new key comes from the blob, nothing else
     * changes) and the session manager reopens with it.
     */
    async function onIdentityRotated(address: string) {
      const me = useAuth.getState().user;
      if (!me) return;
      if (address !== me.address) return contactIdentityChanged(address, queryClient);
      if (useE2ee.getState().status !== "unlocked") return;
      try {
        if ((await syncIdentity(await e2eeContext())) === "rotated") {
          await ownIdentityRotated();
          useToasts.getState().push({ kind: "info", title: t("e2ee.identity_rotated_elsewhere") });
        }
      } catch {
        /* the next start tries again (ensureDevice) */
      }
    }

    /** `identity.changed`: another user's key is re-checked (notice); our own reset elsewhere locks this device. */
    async function onIdentityChanged(address: string) {
      const me = useAuth.getState().user;
      if (!me) return;
      if (address !== me.address) return contactIdentityChanged(address, queryClient);
      const doc = await api.keys.get(me.username).catch(() => null);
      const change = await ownIdentityChange(cryptoStore, doc);
      if (change === "same" || change === "unknown") return; // this device did it, or nothing to compare
      if (change === "rotated") {
        // A rotation with continuity on another device (§9a): follow it, nothing is wiped.
        await onIdentityRotated(address);
        return;
      }
      resetMls();
      await forgetIdentityKeepDevice(me.address);
      useE2ee.getState().set("none");
      useToasts.getState().push({ kind: "warning", title: t("e2ee.identity_reset_elsewhere") });
      navigate(`/encryption?next=${encodeURIComponent(location.pathname)}`, { replace: true });
    }
    socket.connect();
    const prune = setInterval(() => useTyping.getState().prune(), 2000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(prune);
      socket.close();
      socketRef.current = null;
      useRealtimeState.setState({ socket: null, status: "closed" });
    };
  }, [session, queryClient, navigate]);
}

/** A statement of reasons or a decision on a notice about the user's content: notification entry and refresh. */
export function notifyStatement(caseId: string, queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["my-legal-notices"] });
  useNotifications.getState().push({ kind: "legal", title: t("legal.mine.notify_title"), body: t("legal.mine.notify_body", { id: caseId }), path: "/settings/legal" });
}

/**
 * One socket per other node with a federated session: room, message, conversation and MLS events of
 * that node keep the same caches and groups current (`mls.*` of conversations hosted there arrive on
 * this socket, FEDERATION.md §3.6). A refused token (`4001`) renews the federated session.
 */
export function useNodeRealtime() {
  const queryClient = useQueryClient();
  const navigateNow = useNavigate();
  const navigateRef = useRef(navigateNow);
  navigateRef.current = navigateNow;
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => navigateRef.current(to, opts), []);
  const domains = useNodes((s) => Object.keys(s.sessions).sort().join(","));

  useEffect(() => {
    const list = domains ? domains.split(",") : [];
    const opened: Array<{ socket: TavrnSocket; offs: Array<() => void> }> = [];
    const sockets: Record<string, TavrnSocket> = {};
    for (const domain of list) {
      const session = useNodes.getState().sessions[domain];
      if (!session) continue;
      const socket = new TavrnSocket({
        url: session.ws,
        getToken: () => useNodes.getState().sessions[domain]?.token ?? null,
        capabilities: ["content.v1", "reactions", "e2ee.mls1", "commands.v1"],
        onStatus: (status) => {
          // Connected (again): DMs started on that node wait there as Welcomes (§6.1); own leaves to remove.
          if (status === "ready") {
            void queryClient.invalidateQueries({ queryKey: ["my-voice", domain] });
            void loadFollowedThreads({ key: domain, client: apiFor(domain), queryClient });
            void getMls()
              .then(async (m) => {
                await m?.processWelcomes(domain);
                await cleanupOwnLeaves(domain);
              })
              .catch(() => undefined);
          }
        },
        onResync: () => {
          void queryClient.invalidateQueries({ queryKey: ["rooms", domain] });
          void queryClient.invalidateQueries({ queryKey: ["conversations", domain] });
          void queryClient.invalidateQueries({ queryKey: ["my-voice", domain] });
        },
        // A refused token renews the federated session (refresh, else a new federated login).
        refreshToken: () => refreshNode(domain),
      });
      const offs = [
        ...roomHandlers(socket, queryClient, () => useNodes.getState().sessions[domain]?.user ?? null, domain),
        ...mlsHandlers(socket, queryClient, () => domain),
        ...conversationHandlers(socket, queryClient, navigate),
        // Key changes of users this node knows (room co-members); our own is handled by the home socket.
        socket.on<{ user: string }>("identity.changed", (d) => {
          if (d.user !== useAuth.getState().user?.address) void contactIdentityChanged(d.user, queryClient);
        }),
        socket.on<{ user: string }>("identity.rotated", (d) => {
          if (d.user !== useAuth.getState().user?.address) void contactIdentityChanged(d.user, queryClient);
        }),
      ];
      socket.connect();
      sockets[domain] = socket;
      opened.push({ socket, offs });
    }
    useNodeSockets.setState({ sockets });
    return () => {
      for (const { socket, offs } of opened) {
        offs.forEach((off) => off());
        socket.close();
      }
      useNodeSockets.setState({ sockets: {} });
    };
  }, [domains, queryClient, navigate]);
}
