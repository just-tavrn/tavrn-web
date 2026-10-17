// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { TavrnSocket, type TavrnApi, type Conversation, type EphemeralReply, type FriendRequest, type Member, type Message, type PendingInvite, type Presence, type SocketStatus, type User } from "@tavrn/sdk";
import { create } from "zustand";
import { refreshHome, wsUrl } from "../lib/api";
import { cleanupConversation, cleanupOwnLeaves } from "../lib/leafCleanup";
import { useAuth, useSessionKey } from "../stores/auth";
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
import { mayManageRoom, roomManagers } from "../lib/rooms";
import { mapMessages, prependMessage, type MessagePages } from "../lib/messagePages";
import { mergeMessageUpdate, type MessageUpdateEvent } from "../lib/reactionEvents";
import { threadHandlers, threadMessage } from "../threads/realtime";
import { useUnread } from "../stores/unread";
import { isChannelNotice } from "../lib/securityNotice";
import { apiFor, homeDomain, isHome, refreshNode, useNodes } from "../stores/nodes";
import { loadFollowedThreads } from "../threads/loadFollowed";
import { unindexConversation, unindexMessages } from "../search/local";
import { isRealDeletion, useHiddenChannels } from "../lib/hiddenChannels";
import { usePresence } from "../stores/presence";
import { useNotifications } from "../stores/notifications";
import { isAttentive } from "./useMarkRead";
import { loadRoomDetails, locate, notifyMessage } from "../lib/notify";
import { applyUserUpdate, isEventUser } from "../lib/userUpdate";
import { historyPending, historyReceive } from "../crypto/history";
import { historyDecidedEvent, historyRequestEvent } from "../history/restore";
import { registerFilesChannel, useHistoryKeys } from "../files/registry";
import { parseHistoryPolicy } from "@tavrn/e2ee";
import { alertText, reportCreated, type ModerationAlert, type ReportCreated } from "../moderation/realtime";
import { rememberDeleted } from "../moderation/deletedIds";
import { viaOf } from "../components/ViaNode";
import { pollHandlers } from "../polls/votes";
import { roomEventHandlers } from "./roomEvents";
import { roomOfChannel } from "../lib/roomCache";
import { formatDate } from "../lib/format";
import { scopeSocket } from "./socketScope";
import { browserWebSocket } from "../lib/browserWebSocket";
import { conversationsQuery, roomsQuery } from "../lib/queries";

/**
 * May this user commit removals of departed members in a conversation (`mls.remove_needed`)? DMs and group DMs:
 * every member; room channels: members who may kick, ban or manage channels. Leaves of deleted devices and the
 * user's own other leaves every member may remove (ENCRYPTION.md §4.7).
 */
export function mayManageConversation(queryClient: QueryClient, conversationId: string): boolean {
  const owner = roomOfChannel(queryClient, conversationId);
  if (owner) return mayManageRoom(owner.room);
  // The conversation lists of every node (["conversations"] and ["conversations", domain]).
  return queryClient.getQueriesData<Conversation[]>({ queryKey: ["conversations"] }).some(([, list]) => !!list?.some((c) => c.id === conversationId));
}

/**
 * The users who may remove departed members' leaves of a channel (the cleanup election, ENCRYPTION.md §4.7), from the
 * cached room and member list; null when unknown and for DMs and group DMs (there every member may).
 */
export function conversationManagers(queryClient: QueryClient, conversationId: string): string[] | null {
  const owner = roomOfChannel(queryClient, conversationId);
  return owner ? roomManagers(owner.room, queryClient.getQueryData<Member[]>(["members", owner.room.id])) : null;
}

/** The history policy of a channel whose room is cached (ENCRYPTION.md §7b); null if unknown. */
function channelHistoryPolicy(queryClient: QueryClient, conversationId: string) {
  const channel = roomOfChannel(queryClient, conversationId)?.channel;
  return channel?.encrypted ? parseHistoryPolicy(channel.history_for_new_members) : null;
}

/** Registers an encrypted files channel found in the cached rooms for the history key checks; returns the cleanup. */
function registerKnownFilesChannel(queryClient: QueryClient, qualified: string, conversationId: string): () => void {
  const owner = roomOfChannel(queryClient, conversationId);
  return owner?.channel.kind === "files" && owner.channel.encrypted ? registerFilesChannel(qualified, owner.room.id) : () => undefined;
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
          await cleanupConversation(c, { mayManage: mayManageConversation(queryClient, d.conversation_id), managers: conversationManagers(queryClient, d.conversation_id) });
        })
        .catch(() => undefined);
    }),
  ];
}

/**
 * DM and group DM events of any node's socket (PROTOCOL.md §8a), within that node's scope (hooks/socketScope.ts):
 * `node` is the socket's node, null for the home node.
 */
export function conversationHandlers(socket: TavrnSocket, queryClient: QueryClient, navigate: (to: string, opts?: { replace?: boolean }) => void, node: string | null = null): Array<() => void> {
  socket = scopeSocket(socket, queryClient, node);
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

/**
 * A new message in a cached DM or group DM: its `last_message_id` in the node's list (`["conversations"]` home,
 * `["conversations", node]` another node) moves it to the top of the merged list, without refetching any list.
 */
export function patchConversationActivity(queryClient: QueryClient, node: string | null, m: Pick<Message, "conversation_id" | "id">) {
  queryClient.setQueryData<Conversation[]>(node ? ["conversations", node] : ["conversations"], (list) => {
    if (!Array.isArray(list)) return undefined;
    const at = list.findIndex((c) => c.id === m.conversation_id);
    const c = at >= 0 ? list[at]! : null;
    if (!c || (c.last_message_id && c.last_message_id >= m.id)) return undefined;
    return list.map((x, i) => (i === at ? { ...x, last_message_id: m.id } : x));
  });
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
  // A node's events change only that node's rooms and conversations (the keys are shared by every node).
  socket = scopeSocket(socket, queryClient, node);
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
  return [
    socket.on<Message>("message.create", (m) => {
      const self = me();
      // Thread messages (PROTOCOL.md §7e): the open thread's pages; counted and notified only for followers.
      const loadRooms = () => loadRoomDetails(queryClient, node, m.conversation_id);
      if (m.thread_id) {
        if (threadMessage(m, queryClient, self) && self) void notifyMessage(m, { queryClient, node, me: self, loadRooms }).catch(() => undefined);
        return;
      }
      // A security notice in a channel (APPLICATIONS.md §3.6) is a quiet line: never unread, never a notification.
      const notice = isChannelNotice(m);
      // Unread counts: not for the conversation the user is looking at right now.
      if (self) useUnread.getState().message(m, self, notice || (useMlsUi.getState().open === m.conversation_id && isAttentive()));
      // One lookup of the room or DM for everything below.
      const located = locate(queryClient, m.conversation_id);
      // A known DM or group DM moves up in its node's list (order by last activity): patched, nothing is fetched.
      if (located.conversation) patchConversationActivity(queryClient, node, m);
      // Notifications (design note 4.11): toast, sound, notification center, browser notification. An unknown
      // conversation is looked up there (the room on that node, else that node's conversation list).
      if (self && !notice) void notifyMessage(m, { queryClient, node, me: self, loadRooms, located }).catch(() => undefined);
      else if (!located.room && !located.conversation) void queryClient.invalidateQueries({ queryKey: node ? ["conversations", node] : ["conversations"], exact: true });
      // Only the open conversation has loaded pages (lazy history); nothing is fetched for others.
      updatePages(m.conversation_id, (d) => prependMessage(d, m));
      // The answer to a deferred command ends "… is thinking" (APPLICATIONS.md §5.7).
      if (m.interaction) useInteractions.getState().resolve(m.interaction.id);
    }),
    // Events carry no per-viewer state (PROTOCOL.md §6): the viewer's reaction flags stay those of the cached copy.
    socket.on<MessageUpdateEvent>("message.update", (m) => {
      const self = me();
      updatePages(m.conversation_id, (d) => mapMessages(d, (page) => page.map((x) => (x.id === m.id ? mergeMessageUpdate(x, m, self) : x))));
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
    ...threadHandlers(socket, queryClient, me, node),
    // Poll votes (PROTOCOL.md §7g): the shown polls' vote records follow; votes never count as unread or notify.
    ...pollHandlers(socket, queryClient),
    socket.on<{ conversation_id: string; last_read_message_id: string }>("read.update", (d) => useUnread.getState().read(d.conversation_id, d.last_read_message_id, node)),
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
    // The room detail and the room list follow the room's metadata events (patched from their payloads, roomEvents.ts).
    ...roomEventHandlers(socket, queryClient, me),
    // The member list follows member.* from the payloads (roomEvents.ts); a kick or ban of the viewer is announced.
    socket.on<{ room_id: string; user_id: string; kicked?: boolean; banned?: boolean }>("member.leave", (d) => {
      if (d.user_id === me()?.id && (d.kicked || d.banned)) {
        useToasts.getState().push({ kind: "warning", title: t(d.banned ? "notice.banned" : "notice.kicked") });
      }
    }),
    // `hidden: true`: the user lost access (PROTOCOL.md §6), the channel itself still exists.
    socket.on<{ id?: string; hidden?: boolean }>("channel.delete", (d) => {
      useHiddenChannels.getState().deleted(d);
      if (d.id && isRealDeletion(d)) void unindexConversation(qualified(d.id));
    }),
    socket.on<{ id?: string }>("channel.create", (d) => useHiddenChannels.getState().created(d.id)),
    socket.on<{ room_id: string }>("emoji.update", (d) => void queryClient.invalidateQueries({ queryKey: ["emojis", d.room_id] })),
    // An ephemeral reply for this user, from another of its connections' commands or a follow-up (§5.7).
    // Answers to a message component name its message (APPLICATIONS.md §5.10): the reply is shown under it.
    socket.on<EphemeralReply & { message_id?: string | null }>("interaction.reply", (r) =>
      useInteractions.getState().add({ interactionId: r.interaction_id, conversationId: r.conversation_id, messageId: r.message_id ?? null, kind: "ephemeral", application: r.application, content: r.content, epoch: r.epoch, deviceId: r.device_id }),
    ),
    // ---- Profiles and presence (design note 4.9)
    socket.on<Presence>("presence.update", (p) => onPresence(p, node)),
    // The cached lists showing the user are patched from the payload (lib/userUpdate.ts).
    socket.on<{ user: User }>("user.update", (d) => {
      if (!isEventUser(d?.user)) return;
      applyUserUpdate(queryClient, d.user, node);
      if (node === null) applyOwnProfile(d.user);
    }),
    socket.on<{ request: { conversation: Conversation } }>("conversation.request", () => {
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
      useToasts.getState().push({ kind: "info", title: t("requests.toast") });
    }),
    // An app token of one of my applications expires soon (APPLICATIONS.md §2.2).
    socket.on<{ application_id: string; token_id: string; expires_at: string; days: number }>("application.token_expiring", (d) => {
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      useToasts.getState().push({ kind: "warning", title: t("apps.token_expiring", { days: String(d.days) }), detail: formatDate(d.expires_at, "medium") });
    }),
  ];
}

/**
 * A `presence.update`: others go to the store, the own one (unfiltered view) updates `mine`. The own presence is the
 * home node's to say: another node's socket (`node` set) never changes it.
 */
export function onPresence(p: Presence, node: string | null = null) {
  const store = usePresence.getState();
  const me = useAuth.getState().user?.address;
  if (p.user === me) {
    if (node === null && store.mine) store.setMine({ ...store.mine, effective: p.status, custom_status: p.custom_status, activity: p.activity });
    return;
  }
  store.apply(p);
}

/** Fields of the own profile a `user.update` may change: name and avatar (PROTOCOL.md §6), nothing else. */
const OWN_PROFILE_FIELDS = ["display_name", "avatar", "avatar_still", "avatar_blob_id"] as const;

/**
 * The home node's `user.update` of the signed-in account (another device changed the name or avatar): only the display
 * fields are taken over; the account's id, address, domain, username and flags never come from an event. Only the home
 * socket calls this; other nodes' copies of the user are node-local and never merged into the account.
 */
export function applyOwnProfile(user: User) {
  const current = useAuth.getState().user;
  if (!current || user.address !== current.address || user.id !== current.id) return;
  const patch: Partial<User> = {};
  for (const key of OWN_PROFILE_FIELDS) if (key in user) (patch as Record<string, unknown>)[key] = user[key];
  if (OWN_PROFILE_FIELDS.every((k) => patch[k] === undefined || patch[k] === current[k])) return;
  useAuth.getState().setUser({ ...current, ...patch });
}

/**
 * The own account as the home node has it now (`GET /users/me`), taken over on every (re)connection: the stored
 * account dates from the sign-in, and a `user.update` of another device (a new avatar set in the desktop app) is
 * missed while this client is closed; member lists and messages show the current avatar, the account bar would
 * keep the old one (tavrn-web#193). Only the same account is taken over; a failed request changes nothing.
 */
export async function refreshOwnProfile(client: Pick<TavrnApi, "users">): Promise<void> {
  try {
    const me = await client.users.me();
    const current = useAuth.getState().user;
    if (!current || me.id !== current.id || me.address !== current.address) return;
    useAuth.getState().setUser({ ...current, ...me });
  } catch {
    // Offline or a token in refresh: the next connection tries again.
  }
}

/** Connects the WebSocket while a token is present and keeps the query cache up to date. */
export function useRealtime() {
  // One socket per signed-in account and device; refreshed tokens do not reconnect (the socket refreshes itself).
  const session = useSessionKey();
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
      WebSocketImpl: browserWebSocket(),
      getToken: () => useAuth.getState().token,
      capabilities: ["content.v1", "reactions", "e2ee.mls1", "commands.v1"],
      onStatus: (status) => {
        useRealtimeState.setState({ status });
        // (Re)connected: Welcomes that arrived while the socket was down, and own leaves waiting for removal.
        const home = useAuth.getState().user?.domain;
        if (status === "ready" && home) {
          // The own name and avatar as the home node has them (a change made on another device while this one was closed).
          void refreshOwnProfile(api);
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
      onAuthFailure: () => useAuth.getState().sessionRefused(),
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
      ...conversationHandlers(socket, queryClient, navigate, null),
      ...accountNoticeHandlers(socket, queryClient),
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

/**
 * Events of the home node's socket about the account (PROTOCOL.md §6): notification settings changed on another
 * device or tab (§6c), a ban by another room or node (information only), and a friend request or invitation the
 * node could not deliver to another node (FEDERATION.md §5.3).
 */
export function accountNoticeHandlers(socket: TavrnSocket, queryClient: QueryClient): Array<() => void> {
  return [
    socket.on<{ settings?: unknown }>("notifications.update", (d) => {
      if (d && typeof d.settings === "object" && d.settings) useNotifications.getState().applyRemote(d.settings);
    }),
    socket.on<{ room?: { node?: string; id?: string; name?: string }; scope?: string }>("ban.notify", (d) => {
      const node = typeof d?.room?.node === "string" ? d.room.node : "";
      if (!node) return;
      const name = typeof d.room?.name === "string" ? d.room.name : "";
      const title = d.scope === "node" ? t("notice.banned_node", { node }) : name ? t("notice.banned_room", { room: name, node }) : t("notice.banned");
      useToasts.getState().push({ kind: "warning", title });
      void queryClient.invalidateQueries({ queryKey: isHome(node) ? ["rooms"] : ["rooms", node] });
    }),
    socket.on<{ type?: string; to?: string }>("federation.undeliverable", (d) => {
      const to = typeof d?.to === "string" ? d.to : "";
      const friend = d?.type === "friend.request";
      useToasts.getState().push({ kind: "warning", title: t(friend ? "notice.undeliverable_friend" : "notice.undeliverable_invite", { to }), detail: t("notice.undeliverable_hint") });
      void queryClient.invalidateQueries({ queryKey: friend ? ["friends"] : ["pending-invites"] });
    }),
  ];
}

/** A statement of reasons or a decision on a notice about the user's content: notification entry and refresh. */
export function notifyStatement(caseId: string, queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["my-legal-notices"] });
  useNotifications.getState().push({ kind: "legal", title: t("legal.mine.notify_title"), body: t("legal.mine.notify_body", { id: caseId }), path: "/settings/legal" });
}

/**
 * One socket per other node with a federated session: room, message, conversation and MLS events of
 * that node keep the same caches and groups current (`mls.*` of conversations hosted there arrive on
 * this socket, FEDERATION.md §3.6). A refused token (`4001`) renews the federated session. A session added or dropped
 * opens or closes only that node's socket; the others stay connected.
 */
export function useNodeRealtime() {
  const queryClient = useQueryClient();
  const navigateNow = useNavigate();
  const navigateRef = useRef(navigateNow);
  navigateRef.current = navigateNow;
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => navigateRef.current(to, opts), []);
  const domains = useNodes((s) => Object.keys(s.sessions).sort().join(","));
  const open = useRef(new Map<string, NodeSocket>());

  useEffect(() => {
    const wanted = new Set(domains ? domains.split(",") : []);
    const current = open.current;
    for (const [domain, entry] of current) {
      if (wanted.has(domain)) continue;
      closeNodeSocket(entry);
      current.delete(domain);
    }
    for (const domain of wanted) {
      if (current.has(domain)) continue;
      const entry = openNodeSocket(domain, queryClient, navigate);
      if (entry) current.set(domain, entry);
    }
    useNodeSockets.setState({ sockets: Object.fromEntries([...current].map(([d, e]) => [d, e.socket])) });
  }, [domains, queryClient, navigate]);

  // Unmount (sign-out leaves the layout): every node socket closes.
  useEffect(() => {
    const current = open.current;
    return () => {
      for (const entry of current.values()) closeNodeSocket(entry);
      current.clear();
      useNodeSockets.setState({ sockets: {} });
    };
  }, []);
}

interface NodeSocket {
  socket: TavrnSocket;
  offs: Array<() => void>;
}

function closeNodeSocket({ socket, offs }: NodeSocket) {
  offs.forEach((off) => off());
  socket.close();
}

/** The socket of one node with a federated session and its handlers; null without a session. */
function openNodeSocket(domain: string, queryClient: QueryClient, navigate: (to: string, opts?: { replace?: boolean }) => void): NodeSocket | null {
  const session = useNodes.getState().sessions[domain];
  if (!session) return null;
  const socket = new TavrnSocket({
    url: session.ws,
    WebSocketImpl: browserWebSocket(),
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
  // The home node's lists tell its ids apart from this node's (lib/nodeScope.ts); this node's DM list names its DMs.
  void queryClient.prefetchQuery(roomsQuery(null));
  void queryClient.prefetchQuery(conversationsQuery(null));
  void queryClient.prefetchQuery(conversationsQuery(domain));
  const offs = [
    ...roomHandlers(socket, queryClient, () => useNodes.getState().sessions[domain]?.user ?? null, domain),
    ...mlsHandlers(socket, queryClient, () => domain),
    ...conversationHandlers(socket, queryClient, navigate, domain),
    // Key changes of users this node knows (room co-members); our own is handled by the home socket.
    socket.on<{ user: string }>("identity.changed", (d) => {
      if (d.user !== useAuth.getState().user?.address) void contactIdentityChanged(d.user, queryClient);
    }),
    socket.on<{ user: string }>("identity.rotated", (d) => {
      if (d.user !== useAuth.getState().user?.address) void contactIdentityChanged(d.user, queryClient);
    }),
  ];
  socket.connect();
  return { socket, offs };
}
