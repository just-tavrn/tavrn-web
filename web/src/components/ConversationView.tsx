// SPDX-License-Identifier: Apache-2.0
import { ghostNoBots } from "../lib/botAccess";
import { forgetGhostAck, isGhostRefusal, useGhostGate } from "./GhostGate";
import { plainInEncrypted } from "../lib/unverified";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import type { Attachment, Member, Message, RoomDetail } from "@tavrn/sdk";
import { TypingIndicator } from "./TypingIndicator";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { useNode } from "./NodeScope";
import { useT } from "../i18n";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { confirmDialog } from "./Confirm";
import { previewText } from "../lib/messagePreview";
import { EmojiContext, useEmojiUrlMap, useRoomEmojis, type EmojiContextValue } from "../lib/emojis";
import { Permission, declaredCategory, hasPermission } from "@tavrn/sdk";
import { useMlsUi } from "../stores/mls";
import { useMarkRead } from "../hooks/useMarkRead";
import { MESSAGE_QUERY_OPTIONS, PAGE, fetchPage, flatten, isDetached, mapMessages, messagesKey, newerParam, olderParam, prependMessage, trimPages, type MessagePages, type PageParam } from "../lib/messagePages";
import { useThreadMarkRead } from "../threads/useThreadMarkRead";
import { indexEntry, indexMessages } from "../search/local";
import { archiveMessages, pageWithArchive } from "../history/local";
import { rememberRoom } from "../search/sync";
import { SearchButton } from "../search/SearchPanel";
import { useDecrypted, useE2eeConversation, usePlainSignatures } from "../hooks/useE2eeConversation";
import { encryptAttachment, encryptCommandArgs, qualify, signedAttachments, type ContentAttachment, type MessageContext, type PollVoteContent } from "@tavrn/e2ee";
import { withFreshEpoch } from "../lib/epochRetry";
import { withDepartedLeavesGone } from "../lib/leafCleanup";
import { historyReceive } from "../crypto/history";
import { useChannelHistory } from "../hooks/useChannelHistory";
import { HistoryRestoreBanner } from "./HistoryRestoreBanner";
import { useMyRestoreState } from "../history/restore";
import { MessageList, type AuthorLook } from "./MessageList";
import { authorLooks } from "../lib/memberGroups";
import { Composer, type ComposerCommands, type SendPayload } from "./Composer";
import { availableCommands, builtinRegistry } from "../commands/registry";
import { CommandError, executeBuiltin, invokeRequest, resolveAppArgs } from "../commands/execute";
import { appDefinitions, mergePalette } from "../commands/merge";
import type { ArgValue, CommandDefinition } from "../commands/types";
import { InteractionNotices } from "./InteractionNotices";
import { fuzzyFilter } from "../commands/fuzzy";
import { classifyFile } from "../lib/uploads";
import { UnencryptedBanner } from "./UnencryptedBanner";
import { E2eeStatusLine, LockedNotice } from "./E2eeNotices";
import { VerificationNotice } from "./Verification";
import { AuthorProfiles } from "./AuthorProfiles";
import { WhiteboardButton } from "../whiteboard/WhiteboardBadge";
import { extractMentions, type MentionContext } from "../lib/mentions";
import { fitPreview } from "../lib/linkPreview";
import { emojiTokens } from "../lib/markdown";
import { api as homeApi } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useCapabilities } from "../moderation/hooks";
import { ReportDialog } from "../moderation/ReportDialog";
import { evidenceCandidates } from "../moderation/evidence";
import { isAutomodBlock } from "../moderation/blocked";
import { wasDeleted } from "../moderation/deletedIds";
import { LockMark } from "./Badges";
import { BotReaders } from "./BotReaders";
import { sendsTyping, usePresence } from "../stores/presence";
import { useRoomPreview } from "../stores/rolePreview";
import { cutHistory, previewHistoryStart } from "../lib/previewRoom";
import { assertNotPreviewing } from "../lib/previewGuard";
import { PollComposer } from "../polls/PollComposer";
import { ComponentsContext, type ComponentsEnv } from "../messageComponents/context";
import { ComponentModal } from "../messageComponents/ComponentModal";
import { applyAnswer, componentBody, modalBody, type OpenModal, type Sealer } from "../messageComponents/invoke";
import { PollContext } from "../polls/context";
import { useConversationPolls } from "../polls/env";
import type { PollContent, PollKind } from "../polls/model";

/** An error that was already shown to the user. */
class AlreadyReported extends Error {}

export interface ConversationViewProps {
  /** Channel id or DM/group DM id (both are conversation ids). */
  conversationId: string;
  encrypted: boolean;
  header: ReactNode;
  placeholder: string;
  canSend: boolean;
  canManage: boolean;
  canAttach: boolean;
  canReact: boolean;
  canPin: boolean;
  noPermissionReason?: string;
  /** Addresses entitled to be in the MLS group (ghost check); null while loading. */
  members: string[] | null;
  /** DMs and group DMs: member addresses (of any node) whose devices are added by Welcome. */
  direct?: string[];
  /** May remove leaves of departed users (channels: kick/ban/manage channels; DMs: every member). */
  mayManage: boolean;
  /** Fresh member addresses (bypassing caches) before acting on a ghost violation. */
  refreshMembers?: () => Promise<string[]>;
  bots?: ReadonlySet<string>;
  /** Room channels: custom emojis and typing indicators. */
  roomId?: string;
  /** Node domain for the mandatory notice in unencrypted channels. */
  domain: string;
  /** Who can be mentioned (`@name`, `@Role`, `@everyone`); without it no mentions are sent. */
  mentionContext?: MentionContext;
  /** Read-only conversations (the welcome channel): this note replaces the composer. */
  readOnlyNote?: string;
  /** The user's effective permissions here (slash commands are filtered by them). */
  permissions?: bigint;
  /** Room channels: the room and its members (command arguments). */
  room?: RoomDetail;
  roomMembers?: Member[];
  /** DMs and group DMs: the members with their display names (message authors are shown with them). */
  people?: { address: string; display_name?: string | null }[];
  /**
   * Thread mode (PROTOCOL.md §7e): the view pages and writes this thread of the channel. Its root message (text
   * threads) is shown first once the thread's history is loaded; pins, search and the whiteboard stay with the channel.
   */
  threadId?: string;
  threadRoot?: Message | null;
  /** Channel mode: start a thread from a message or answer in its thread (message menu, thread indicator). */
  onThread?: (m: Message, mode: "create" | "reply", text: string) => void;
  /** Jump to `?m=<id>` (off for the channel while a thread panel owns the link). */
  jumpEnabled?: boolean;
  /** The user may start threads from messages here. */
  canStartThreads?: boolean;
  /** Replaces the composer while sending is not possible (announcement channels, locked threads). */
  composerNote?: string;
}

/**
 * Message area of any conversation (room channel, DM, group DM) over the conversation routes. In
 * encrypted conversations it joins the MLS group, encrypts what is sent (also attachments), decrypts
 * what is shown and enforces the ghost check before sending.
 */
export function ConversationView(p: ConversationViewProps) {
  const t = useT();
  const { conversationId } = p;
  // The node hosting the conversation, and the user as that node knows it (node-local id).
  const { api, me: user, home, domain } = useNode();
  const queryClient = useQueryClient();
  const homeSocket = useRealtimeState((s) => s.socket);
  const nodeSocket = useNodeSockets((s) => s.sockets[domain]);
  const socket = home ? homeSocket : nodeSocket;
  const node = useQuery({ queryKey: home ? ["well-known"] : ["well-known", domain], queryFn: () => api.node.wellKnown(), staleTime: 10 * 60_000 });
  const nodeInfo = useQuery({ queryKey: home ? ["node"] : ["node", domain], queryFn: () => api.node.info(), staleTime: 10 * 60_000 });
  const threadId = p.threadId;
  const messageKey = useMemo(() => messagesKey(conversationId, threadId), [conversationId, threadId]);
  // Welcome channel entries name only the channels in the viewer's list (APPLICATIONS.md §3.6).
  const roomChannels = p.room?.channels;
  const visibleChannels = useMemo(() => (roomChannels ? new Set(roomChannels.map((c) => c.id)) : undefined), [roomChannels]);
  // MLS names the conversation by its qualified id: the node hosting it and the ULID (ENCRYPTION.md §0.1).
  const q = qualify(domain, conversationId);
  // Lazy history (design note 4.4): newest page on open, older pages on demand; dropped when closed. With "keep the
  // full history on this device" the pages come from the device's archive while the node cannot be reached (#4).
  const messages = useInfiniteQuery({
    queryKey: messageKey,
    queryFn: ({ pageParam }) => pageWithArchive(q, () => fetchPage(api, conversationId, pageParam, threadId), pageParam, threadId),
    initialPageParam: undefined as PageParam,
    getNextPageParam: (last) => olderParam(last),
    // After a jump into the history (`around`): newer pages up to the live end.
    getPreviousPageParam: (first, _all, firstParam) => newerParam(first, firstParam),
    // Kept current by the WebSocket, dropped when closed, no structural sharing (keeps message identities).
    ...MESSAGE_QUERY_OPTIONS,
  });
  const fetched = useMemo(() => flatten(messages.data), [messages.data]);
  // A thread starts with its root message (the channel message it was started from) once its history is complete.
  const threadRoot = p.threadRoot;
  const all = useMemo(
    () => (threadRoot && messages.data && !messages.hasNextPage ? [...fetched, threadRoot] : fetched),
    [fetched, threadRoot, messages.data, messages.hasNextPage],
  );
  // Role preview (docs/CLIENT.md): encrypted messages from before the window a new member with the role would get are
  // cut; plaintext messages never are. Nothing older is loaded once the cut lies within the loaded pages.
  const preview = useRoomPreview(p.roomId);
  const previewChannel = p.room?.channels.find((c) => c.id === conversationId);
  const historyStart = preview && previewChannel ? previewHistoryStart(previewChannel, p.permissions ?? 0n, preview.joinedAt) : null;
  const windowed = useMemo(() => cutHistory(all, historyStart), [all, historyStart]);
  const loaded = windowed.items;
  const historyCut = historyStart !== null && (windowed.cut || (!!messages.data && !messages.hasNextPage));
  const detached = isDetached(messages.data);
  const setPages = (fn: (d: MessagePages<Message> | undefined) => MessagePages<Message> | undefined) => queryClient.setQueryData<MessagePages<Message>>(messageKey, fn);
  const emojis = useRoomEmojis(p.roomId ?? "");
  const emojiList = useMemo(() => emojis.data ?? [], [emojis.data]);
  const emojiUrls = useEmojiUrlMap(p.roomId ?? "", emojiList);
  const customEmojis = useMemo(() => emojiList.map((e) => ({ id: e.id, name: e.name, roomId: p.roomId ?? "", animated: !!e.animated })), [emojiList, p.roomId]);
  // Emojis of other rooms and personal ones (design note 4.13): `use_external_emojis` in room channels, always in DMs.
  const externalAllowed = !p.roomId || hasPermission(p.permissions ?? 0n, Permission.USE_EXTERNAL_EMOJIS);
  const [showPins, setShowPins] = useState(false);
  const pins = useQuery({ queryKey: ["pins", conversationId], queryFn: () => api.conversations.pins(conversationId), enabled: showPins });
  /** Keys of encrypted uploads until the message is sent (memory only). */
  const uploadKeys = useRef(new Map<string, ContentAttachment>());
  /** Plaintext uploads until the message is sent: size and hash are covered by the signature. */
  const uploads = useRef(new Map<string, Attachment>());
  const verification = useMlsUi((s) => s.verification);
  /** The message being replied to (design note 4.11, message menu "Reply"). */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // Reports (MODERATION.md §1.1): room channels go to the room's node, DMs and group DMs to the home node (with the
  // hosting node named when the conversation lives elsewhere).
  const [reporting, setReporting] = useState<Message | null>(null);
  const homeDomain = useAuth((s) => s.user?.domain ?? "");
  const remoteDirect = !p.roomId && !home;
  const reportCaps = useCapabilities(home || remoteDirect ? null : domain);
  const canReport = !!reportCaps?.includes("reports.v1");
  const navigate = useNavigate();
  const location = useLocation();
  const uploadPolicyQuery = { queryKey: ["upload-policy", domain, conversationId], queryFn: () => api.attachments.policy(conversationId), staleTime: 60_000 };
  const uploadPolicy = useQuery({ ...uploadPolicyQuery, enabled: p.canAttach });
  const toComposerPolicy = (d: { allowed_categories: string[]; executables_allowed: boolean }) => ({ allowed: d.allowed_categories, executablesAllowed: d.executables_allowed });
  // A file picked before the policy has loaded waits for it (the in-flight request), so the composer refuses a
  // forbidden type itself instead of uploading it for the node to refuse.
  const resolveUploadPolicy = () => queryClient.fetchQuery(uploadPolicyQuery).then(toComposerPolicy);

  // Room channels with an effective "no bots" flag: bot leaves are ghosts (APPLICATIONS.md §3.5). The client also
  // applies the room's `bots_in_encrypted_channels` itself (design note 4.7).
  const noBots = ghostNoBots(p.room?.channels.find((c) => c.id === conversationId), p.room);
  const e2ee = useE2eeConversation({ conversationId: q, encrypted: p.encrypted, canCreate: p.canSend, members: p.members, direct: p.direct, mayManage: p.mayManage, refreshMembers: p.refreshMembers, noBots });
  // The ghost gate (§4.6): leaves of deleted devices read "removed, cleanup pending" (§4.7); nothing is encrypted
  // while a ghost is not acknowledged (messages, edits; the session manager refuses as well).
  const gate = useGhostGate(q, e2ee, p.encrypted);
  const decrypted = useDecrypted(q, loaded, e2ee.mls, e2ee.tick);
  const pinDecrypted = useDecrypted(q, pins.data?.messages, e2ee.mls, e2ee.tick);
  const signatures = usePlainSignatures(q, loaded, e2ee.mls, e2ee.tick);
  // Local search index (design note 4.4): what this device decrypted for display goes in (text and file names,
  // sealed); every message version once.
  const indexedRef = useRef(new Set<string>());
  useEffect(() => {
    const entries = [];
    for (const m of loaded) {
      const key = `${m.id}|${m.edited_at ?? ""}`;
      if (!m.encrypted || indexedRef.current.has(key)) continue;
      const entry = indexEntry(q, m, decrypted[m.id], p.roomId);
      if (!entry) continue;
      indexedRef.current.add(key);
      entries.push(entry);
    }
    if (entries.length) void indexMessages(entries);
  }, [decrypted, loaded, q, p.roomId]);
  // "Keep the full history on this device" (#4): what is shown goes into the device's archive (decrypted content of
  // encrypted messages once it is there, plaintext ones as they are); every message version once.
  const archivedRef = useRef(new Set<string>());
  useEffect(() => {
    const items = [];
    for (const m of fetched) {
      const key = `${m.id}|${m.edited_at ?? ""}`;
      if (archivedRef.current.has(key)) continue;
      const d = m.encrypted ? decrypted[m.id] : null;
      if (m.encrypted && !d?.ok) continue;
      archivedRef.current.add(key);
      items.push({ message: m, decrypted: d ?? null });
    }
    if (items.length) void archiveMessages(q, items);
  }, [decrypted, fetched, q]);
  useEffect(() => {
    if (p.roomId && e2ee.phase === "ready") void rememberRoom(q, p.roomId);
  }, [q, p.roomId, e2ee.phase]);

  // Jump to a message (`?m=<id>`, a search result): load the page around it unless it is loaded already.
  const focusParam = p.jumpEnabled === false ? null : (new URLSearchParams(location.search).get("m")?.toUpperCase() ?? null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!focusParam) return;
    let cancelled = false;
    void (async () => {
      const current = queryClient.getQueryData<MessagePages<Message>>(messageKey);
      if (!current?.pages.some((page) => page.some((m) => m.id === focusParam))) {
        try {
          const page = await api.conversations.messages(conversationId, { limit: PAGE, around: focusParam, ...(threadId ? { thread: threadId } : {}) });
          if (cancelled) return;
          await queryClient.cancelQueries({ queryKey: messageKey, exact: true });
          queryClient.setQueryData<MessagePages<Message>>(messageKey, { pages: [page], pageParams: [{ around: focusParam }] });
        } catch (e) {
          if (!cancelled) toastError(e, t("search.jump_failed"));
          return;
        }
      }
      if (!cancelled) setFocus({ id: focusParam, n: Date.now() });
    })();
    return () => {
      cancelled = true;
    };
    // A repeated click on the same result navigates again (new location key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, location.key, conversationId]);
  const jumpLatest = () => {
    setFocus(null);
    if (focusParam) navigate(location.pathname, { replace: true });
    void queryClient.resetQueries({ queryKey: messageKey, exact: true });
  };
  // Verified contacts whose key changed (FEDERATION.md §10.2): DMs and group DMs block sending.
  const broken = useMemo(() => (p.members ?? []).filter((a) => a !== user?.address && verification[a] === "broken"), [p.members, user?.address, verification]);
  // Author names and role colours like the member list (design note 4.13 item 3): nickname, then display name.
  const roles = p.room?.roles;
  // `@Role` in a message becomes a mention pill (tavrn-web#122); @everyone has its own kind.
  const mentionRoles = useMemo(() => roles?.filter((r) => !r.is_everyone).map((r) => r.name), [roles]);
  // DMs and group DMs: the members' display names, the same source as the header and the member list.
  const authors = useMemo<Map<string, AuthorLook> | undefined>(() => authorLooks({ roomMembers: p.roomMembers, roles, people: p.people }), [p.roomMembers, roles, p.people]);
  const usersById = useMemo(() => (p.roomMembers ? new Map(p.roomMembers.map((m) => [m.user.id, m.user])) : undefined), [p.roomMembers]);
  const verificationBlock = !!p.direct && broken.length > 0;

  // History for new members (ENCRYPTION.md §7b): every encrypted room channel, `since_join` included.
  const historyChannel = p.room?.channels.find((c) => c.id === conversationId);
  const { active: historyActive, locked: historyLocked } = useChannelHistory({
    api,
    domain,
    q,
    channelId: conversationId,
    encrypted: !!historyChannel && p.encrypted,
    policy: historyChannel?.history_for_new_members,
    ready: e2ee.phase === "ready",
  });
  // After a key reset an approved restore brings keys also where the policy gives new members nothing (§7b).
  const restoreState = useMyRestoreState(api, home ? null : domain, p.room && p.encrypted && !threadId ? p.room.id : null);
  const restored = !!restoreState.data?.restored_at && p.encrypted && e2ee.phase === "ready";
  useEffect(() => {
    if (!restored || historyActive) return;
    void historyReceive(q);
  }, [restored, historyActive, q]);

  useEffect(() => {
    // The channel is the open conversation; a thread panel next to it marks only its thread.
    if (threadId) return;
    useMlsUi.setState({ open: conversationId });
    return () => useMlsUi.setState((s) => (s.open === conversationId ? { open: null } : s));
  }, [conversationId, threadId]);
  // The preview reads nothing as the role: no read markers (the guard would refuse them anyway).
  useMarkRead(threadId || preview ? "" : conversationId, fetched[0]?.id);
  useThreadMarkRead(preview ? undefined : threadId, fetched[0]?.id);

  const ready = !p.encrypted || e2ee.phase === "ready" || e2ee.phase === "no_group";
  const waiting = p.encrypted && e2ee.waiting.length > 0;
  const ghostBlock = gate.blocked;
  const canSendNow = p.canSend && (!p.encrypted || e2ee.phase === "ready") && !waiting && !ghostBlock && !verificationBlock;
  const disabledReason = !p.canSend
    ? p.noPermissionReason
    : p.encrypted && (e2ee.phase === "locked" || e2ee.phase === "plain")
      ? t("e2ee.composer_locked")
      : ghostBlock
        ? t("e2ee.composer_ghost")
        : verificationBlock
          ? t("safety.composer_blocked")
        : waiting
          ? t("e2ee.status.waiting", { detail: e2ee.waiting.join(", ") })
          : p.encrypted && !ready
            ? t("e2ee.status.joining")
            : p.encrypted && e2ee.phase === "error"
              ? e2ee.error ?? undefined
              : undefined;

  // The effective limit of this user here (entitlements, design note 4.13); the node default until it loaded.
  const uploadLimit = uploadPolicy.data?.max_bytes ?? node.data?.policies.upload_max_bytes;

  const updateMessage = (m: Message) => setPages((old) => mapMessages(old, (page) => page.map((x) => (x.id === m.id ? m : x))));
  const react = async (m: Message, emoji: string, active: boolean) => {
    try {
      updateMessage(active ? await api.conversations.unreact(conversationId, m.id, emoji) : await api.conversations.react(conversationId, m.id, emoji));
    } catch (e) {
      toastError(e);
    }
  };
  const pin = async (m: Message, pinned: boolean) => {
    try {
      updateMessage(pinned ? await api.conversations.pin(conversationId, m.id) : await api.conversations.unpin(conversationId, m.id));
      await queryClient.invalidateQueries({ queryKey: ["pins", conversationId] });
    } catch (e) {
      toastError(e);
    }
  };

  const upload = async (file: File, onProgress: (f: number) => void, signal: AbortSignal): Promise<Attachment> => {
    // Uploads go by XMLHttpRequest (progress), past the fetch guard: refused here while previewing.
    assertNotPreviewing();
    // Removed in the composer (or the conversation closed): the request is aborted (`request.aborted`), the upload's
    // state goes at once and an answer that arrived just before is dropped. The node deletes uploads never sent.
    const scoped = api.withSignal(signal);
    const keep = (stored: Attachment, store: () => void) => {
      signal.throwIfAborted();
      store();
      signal.addEventListener("abort", () => {
        uploads.current.delete(stored.id);
        uploadKeys.current.delete(stored.id);
      });
      return stored;
    };
    if (!p.encrypted) {
      const stored = await scoped.attachments.uploadToConversation(conversationId, file, file.name, onProgress);
      return keep(stored, () => uploads.current.set(stored.id, stored));
    }
    // §6: encrypt locally, upload only ciphertext; name, type and key go into the encrypted content. The
    // category is declared (PROTOCOL.md §7a): the node cannot see the file.
    const category = declaredCategory(await classifyFile(file));
    const { blob, meta } = await encryptAttachment(file);
    signal.throwIfAborted();
    const stored = await scoped.attachments.uploadToConversation(conversationId, blob, "", onProgress, category);
    if (stored.sha256 !== meta.sha256) throw new Error(t("attachment.upload_mismatch"));
    return keep(stored, () => uploadKeys.current.set(stored.id, { id: stored.id, ...meta }));
  };

  /**
   * Plaintext content or `{ content, epoch }` of the encrypted content object, with the envelope's thread and reply
   * signed inside (ENCRYPTION.md §5.2). The roster is checked again if commits arrived just before (§4.6): the members
   * and the ghosts this view shows go along.
   */
  const seal = async (content: Record<string, unknown>, ctx: MessageContext): Promise<{ content: unknown; epoch?: number }> => {
    if (!p.encrypted) return { content };
    if (!e2ee.mls) throw new Error(t("e2ee.composer_locked"));
    if (gate.blocked) throw new Error(t("e2ee.composer_ghost"));
    const mls = e2ee.mls;
    try {
      // Right after a member left, the departed member's leaf goes first (issue #86).
      return await withDepartedLeavesGone(q, { members: p.members, mayManage: p.mayManage, noBots }, () => mls.encrypt(q, content, { ctx, ...(p.members ? { members: p.members, noBots } : {}) }));
    } catch (e) {
      // A device joined that nobody was shown yet: the warning has to be acknowledged again.
      if (isGhostRefusal(e)) forgetGhostAck(q);
      throw e;
    }
  };

  const send = async ({ body, attachmentIds, gif, preview, spoilerIds }: SendPayload) => {
    const content: Record<string, unknown> = { type: "text", body: body || (gif ? "" : "📎") };
    if (gif) content.gif = { url: gif.url, preview_url: gif.preview_url, width: gif.width, height: gif.height };
    // The sender's link preview travels in the content (encrypted with it in E2EE, signed with it in plaintext).
    if (preview) content.preview = fitPreview(content, preview, p.encrypted);
    await deliver(content, attachmentIds, spoilerIds);
  };
  /** Seals, signs and sends a content object (text, `/me` actions) with the given uploads (some as spoilers). */
  const deliver = async (content: Record<string, unknown>, attachmentIds: string[] = [], spoilerIds: string[] = [], extra: { poll_closes_at?: string } = {}) => {
    try {
      // Before anything is encrypted: the role preview sends nothing.
      assertNotPreviewing();
      // Mentions travel in the plaintext envelope (PROTOCOL.md §7), extracted from the text.
      const text = typeof content.body === "string" ? content.body : "";
      // External emojis (design note 4.13): the node checks plaintext bodies; encrypted ones only the client can.
      if (!externalAllowed && emojiTokens(text).some((tk) => (tk.host && tk.host !== domain) || !emojiList.some((e) => e.id === tk.id))) {
        throw new Error(t("emoji_picker.external_denied"));
      }
      const { mentions, mentions_everyone } = p.mentionContext ? extractMentions(text, p.mentionContext) : { mentions: [] as string[], mentions_everyone: false };
      const reply = replyTo?.id ?? null;
      if (p.encrypted && attachmentIds.length) {
        content.attachments = attachmentIds
          .map((id) => uploadKeys.current.get(id))
          .filter((a): a is ContentAttachment => !!a)
          .map((a) => (spoilerIds.includes(a.id) ? { ...a, spoiler: true } : a));
      }
      // Plaintext: device signature over the envelope fields and the content (FEDERATION.md §10.3),
      // best effort (no device key yet: unsigned).
      let signature: string | null = null;
      if (!p.encrypted && e2ee.mls) {
        const files = attachmentIds.map((id) => uploads.current.get(id));
        if (files.every((f) => !!f)) {
          signature = e2ee.mls.signPlaintext(q, { reply_to: reply, thread_id: threadId ?? null, mentions_everyone, mentions, attachments: signedAttachments(files as Attachment[]) }, content);
        }
      }
      const spoilers = !p.encrypted && spoilerIds.length ? { spoilers: spoilerIds.filter((id) => attachmentIds.includes(id)) } : {};
      const created = await withFreshEpoch(p.encrypted ? e2ee.mls : null, q, async () => {
        const sealed = await seal(content, { thread_id: threadId ?? null, reply_to: reply });
        return api.conversations.send(conversationId, { ...sealed, attachments: attachmentIds, mentions, mentions_everyone, reply_to_id: reply, ...spoilers, ...extra, ...(signature ? { signature } : {}), ...(threadId ? { thread_id: threadId } : {}) });
      });
      setReplyTo(null);
      for (const id of attachmentIds) {
        uploadKeys.current.delete(id);
        uploads.current.delete(id);
      }
      // Auto-moderation may have removed it already (its `message.delete` can come before this answer).
      if (!wasDeleted(created.id)) setPages((old) => prependMessage(old, created));
    } catch (e) {
      // Auto-moderation blocks are shown in the composer itself (MODERATION.md §2.2).
      if (!isAutomodBlock(e)) toastError(e, t("messages.send_failed"));
      throw e;
    }
  };
  // Slash commands run from a memoized runner; they must reach the *current* send path (encryption
  // state, MLS manager, reply and mentions), never the one captured when the runner was built.
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  const edit = async (m: Message, body: string) => {
    try {
      assertNotPreviewing();
      const previous = m.encrypted ? (decrypted[m.id]?.ok ? (decrypted[m.id] as { content: Record<string, unknown> }).content : null) : (m.content as Record<string, unknown>);
      // Without the decrypted original there is nothing to edit: refused with a notice, the editor keeps the text.
      if (!previous) throw new Error(t("messages.edit_not_decrypted"));
      const next = { ...previous, type: previous.type === "action" ? "action" : "text", body };
      // Edits are signed anew by the editing device (§10.3); the bound attachments stay.
      const signature = !p.encrypted && e2ee.mls
        ? e2ee.mls.signPlaintext(q, { reply_to: m.reply_to_id ?? null, thread_id: m.thread_id ?? null, mentions_everyone: m.mentions_everyone, mentions: m.mentions, attachments: signedAttachments(m.attachments ?? []) }, next)
        : null;
      const edited = await withFreshEpoch(p.encrypted ? e2ee.mls : null, q, async () => {
        const sealed = await seal(next, { thread_id: m.thread_id ?? null, reply_to: m.reply_to_id ?? null });
        return api.conversations.edit(conversationId, m.id, { ...sealed, mentions: m.mentions, mentions_everyone: m.mentions_everyone, ...(signature ? { signature } : {}) });
      });
      updateMessage(edited);
    } catch (e) {
      toastError(e);
      throw e;
    }
  };
  const remove = async (m: Message) => {
    if (!(await confirmDialog({ title: t("messages.delete"), text: t("messages.delete_confirm"), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api.conversations.deleteMessage(conversationId, m.id);
      setPages((old) => mapMessages(old, (page) => page.filter((x) => x.id !== m.id)));
    } catch (e) {
      toastError(e);
    }
  };
  // Polls (PROTOCOL.md §7g): created where the node offers them, with `create_polls` (DMs grant it to every member).
  const pollsOffered = !!nodeInfo.data?.capabilities?.includes("polls.v1");
  const canPoll = pollsOffered && p.canSend && !p.readOnlyNote && !p.composerNote && hasPermission(p.permissions ?? 0n, Permission.CREATE_POLLS);
  const [pollComposer, setPollComposer] = useState<{ kind: PollKind; question: string } | null>(null);
  const createPoll = async (content: PollContent & { type: "poll" }, closesAt: string | null) => {
    try {
      await deliver({ ...content }, [], [], closesAt ? { poll_closes_at: closesAt } : {});
    } catch (e) {
      throw new AlreadyReported(describeError(e));
    }
  };
  /** Votes are sealed like messages: the ghost gate and the departed-leaf cleanup apply (§4.6, issue #86). */
  const encryptVote = async (vote: PollVoteContent) => {
    const mls = e2ee.mls;
    if (!mls) throw new Error(t("e2ee.composer_locked"));
    if (gate.blocked) throw new Error(t("e2ee.composer_ghost"));
    return withDepartedLeavesGone(q, { members: p.members, mayManage: p.mayManage, noBots }, () => mls.encrypt(q, vote as unknown as Record<string, unknown>, p.members ? { members: p.members, noBots } : {}));
  };
  const pollName = (address: string) => authors?.get(address)?.name ?? address.split("@")[0] ?? address;
  const pollEnv = useConversationPolls({
    api,
    conversationId,
    q,
    encrypted: p.encrypted,
    mls: e2ee.mls,
    me: user?.address,
    // Everybody who may read the conversation may vote (§7g); locked encryption cannot seal a vote.
    canVote: pollsOffered && !p.readOnlyNote && (!p.encrypted || (e2ee.phase === "ready" && !gate.blocked)),
    canManage: p.canManage,
    name: pollName,
    encryptVote,
    onClosed: updateMessage,
  });
  // Application commands of this conversation (APPLICATIONS.md §5.4), when the node offers them.
  const commandsOffered = !!nodeInfo.data?.capabilities?.includes("commands.v1");
  const palette = useQuery({
    queryKey: ["commands", domain, conversationId],
    queryFn: () => api.commands.palette(conversationId),
    enabled: commandsOffered && p.canSend && !p.readOnlyNote && !p.composerNote,
    staleTime: 60_000,
  });
  const appCommands = useMemo(() => appDefinitions(palette.data), [palette.data]);
  // Where answers to commands and components go (APPLICATIONS.md §5.7, §5.10); a modal opens the bot's form.
  const [modal, setModal] = useState<OpenModal | null>(null);
  const answerTarget = { conversationId, addMessage: (m: Message) => setPages((old) => prependMessage(old, m)), updateMessage, openModal: setModal };
  /** Invokes an application command; the answer is a message, an ephemeral reply, "thinking…", an error notice or a modal. */
  const invokeApp = async (def: CommandDefinition, values: Record<string, ArgValue>) => {
    if (!def.ref || !def.application) return;
    const args = resolveAppArgs(def, values, { members: p.roomMembers, room: p.room });
    let sealed: { args?: Record<string, ArgValue>; args_ciphertext?: string; epoch?: number };
    if (p.encrypted) {
      // The arguments are encrypted for the group; the node sees only the command (§5.8).
      if (!e2ee.mls) throw new Error(t("e2ee.composer_locked"));
      sealed = await encryptCommandArgs(e2ee.mls, q, def.ref, args);
    } else {
      sealed = { args };
    }
    const res = await api.commands.invoke(conversationId, invokeRequest(def.ref, sealed, threadId));
    applyAnswer(res, { ...answerTarget, application: def.application, messageId: null });
  };
  // Message components (APPLICATIONS.md §5.10): buttons and selects of bot messages, and the modals bots answer with.
  const sealer = (): Sealer => {
    if (!p.encrypted) return { mls: null, conversation: null };
    // Values are encrypted for the group like command arguments; the node sees only the component's id (§5.10).
    if (!e2ee.mls) throw new Error(t("e2ee.composer_locked"));
    return { mls: e2ee.mls, conversation: q };
  };
  const invokeMessageComponent = async (m: Message, customId: string, values: string[] | null) => {
    const res = await api.components.invoke(conversationId, m.id, await componentBody(sealer(), m.id, customId, values));
    const look = authors?.get(m.author);
    applyAnswer(res, { ...answerTarget, application: res.ephemeral?.application ?? { ref: "", name: look?.name || (m.author.split("@")[0] ?? m.author), bot: m.author }, messageId: m.id });
  };
  const invokeComponentRef = useRef(invokeMessageComponent);
  invokeComponentRef.current = invokeMessageComponent;
  const submitOpenModal = async (open: OpenModal, values: Record<string, string>) => {
    const res = await api.interactions.submit(open.interactionId, await modalBody(sealer(), open.interactionId, open.modal.custom_id, values));
    applyAnswer(res, { ...answerTarget, application: res.ephemeral?.application ?? open.application, messageId: open.messageId });
  };
  // DMs and group DMs grant every permission of a conversation to its members.
  const canUseComponents = p.permissions === undefined || hasPermission(p.permissions, Permission.USE_COMPONENTS);
  const componentsEnv = useMemo<ComponentsEnv>(
    () => ({
      conversationId,
      canUse: canUseComponents,
      invoke: (m, customId, values) => invokeComponentRef.current(m, customId, values),
      jump: p.jumpEnabled === false ? undefined : (id) => navigate(`${location.pathname}?m=${id}`),
      qualified: q,
      encrypted: p.encrypted,
      mls: e2ee.mls,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, canUseComponents, q, p.encrypted, e2ee.mls, p.jumpEnabled, location.pathname],
  );
  const invokeRef = useRef(invokeApp);
  invokeRef.current = invokeApp;
  // Slash commands (design note 4.11): built-ins filtered by the user's permissions here, then application commands.
  const registry = useMemo(() => builtinRegistry(), []);
  const hasVoice = !!p.room?.channels.some((c) => c.kind === "voice");
  const commands = useMemo<ComposerCommands>(() => {
    const scope = { permissions: p.permissions ?? 0n, direct: !p.roomId, hasVoice };
    // `/poll` only where the node offers polls (PROTOCOL.md §7g).
    const builtins = availableCommands(registry, scope).filter((d) => d.name !== "poll" || pollsOffered);
    const available = mergePalette(builtins, appCommands, scope);
    return {
      available,
      suggest: (arg, partial) => {
        const q = partial.replace(/^[@#]/, "");
        if (arg.type === "user") {
          const members = p.roomMembers ?? [];
          return fuzzyFilter(members, q, (m) => `${m.user.username} ${m.nick ?? ""} ${m.user.display_name}`)
            .slice(0, 8)
            .map((m) => ({ value: `@${m.user.domain === (user?.domain ?? domain) ? m.user.username : m.user.address}`, label: `${m.nick ?? m.user.display_name} (${m.user.address})` }));
        }
        const voice = (p.room?.channels ?? []).filter((c) => c.kind === "voice");
        return fuzzyFilter(voice, q, (c) => c.name).map((c) => ({ value: `#${c.name.includes(" ") ? c.id : c.name}`, label: `🔊 ${c.name}` }));
      },
      run: async (def, values) => {
        try {
          if (def.source === "app") {
            await invokeRef.current(def, values);
            return;
          }
          await executeBuiltin(def, values, {
            api,
            t,
            conversationId,
            roomId: p.roomId,
            room: p.room,
            members: p.roomMembers,
            sendContent: async (content) => {
              try {
                await deliverRef.current({ ...content });
              } catch {
                throw new AlreadyReported();
              }
            },
            openWhiteboard: () => navigate(`${location.pathname.replace(/\/+$/, "")}/whiteboard`),
            openPoll: (question) => setPollComposer({ kind: "choice", question }),
            confirm: (text) => confirmDialog({ text, danger: true }),
            info: (title) => useToasts.getState().push({ kind: "info", title }),
            showHelp: () => undefined,
          });
          if (["kick", "ban", "timeout", "nick"].includes(def.name) && p.roomId) {
            void queryClient.invalidateQueries({ queryKey: ["members", p.roomId] });
          }
        } catch (e) {
          if (e instanceof CommandError) toastError(new Error(t(e.message)));
          else if (!(e instanceof AlreadyReported)) toastError(e);
          throw e;
        }
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, appCommands, p.permissions, p.roomId, p.room, p.roomMembers, hasVoice, conversationId, domain, user?.domain, location.pathname, pollsOffered, t]);

  const emojiContext = useMemo<EmojiContextValue>(() => ({ domain, roomId: p.roomId, externalAllowed, roomEmojis: emojiList }), [domain, p.roomId, externalAllowed, emojiList]);

  const loadOlder = () => {
    if (!messages.hasNextPage || messages.isFetchingNextPage) return;
    void messages.fetchNextPage();
  };

  const pinText = (m: Message): string => {
    // Plaintext in an encrypted conversation can only come from the node (ENCRYPTION.md §5.4): never shown.
    if (plainInEncrypted(m, p.encrypted)) return t("messages.not_e2ee_short");
    const c = m.encrypted ? (pinDecrypted[m.id]?.ok ? (pinDecrypted[m.id] as { content: Record<string, unknown> }).content : null) : (m.content as Record<string, unknown> | null);
    if (m.encrypted && !c) return t("messages.encrypted_short");
    return previewText(c, 200) ?? t("channel.attachment");
  };

  return (
    <EmojiContext.Provider value={emojiContext}>
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-line px-4">
        {p.header}
        {p.encrypted && (
          <LockMark size={18} title={t("e2ee.encrypted_hint")} testId="encrypted-marker" />
        )}
        {p.encrypted && p.roomId && <BotReaders mls={e2ee.mls} conversation={q} tick={e2ee.tick} bots={p.bots} members={p.roomMembers} />}
        {!threadId && (
          <>
            <span className="flex-1" />
            <SearchButton conversationId={conversationId} encrypted={p.encrypted} roomId={p.roomId} room={p.room} members={p.roomMembers} />
            <WhiteboardButton conversationId={conversationId} encrypted={p.encrypted} />
            <button type="button" aria-label={t("channel.pins")} aria-pressed={showPins} onClick={() => setShowPins((v) => !v)} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0 aria-pressed:bg-accent-soft aria-pressed:text-accent">
              📌
            </button>
          </>
        )}
      </header>
      {showPins && (
        <div className="max-h-64 overflow-y-auto border-b border-line bg-bg-1 px-4 py-2" data-testid="pin-panel">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-2">{t("channel.pinned")}</p>
          {pins.data?.messages.length === 0 && <p className="text-sm text-fg-2">{t("channel.no_pins")}</p>}
          <ul className="space-y-1 text-sm">
            {pins.data?.messages.map((m) => (
              <li key={m.id} className="truncate">
                <span className="font-medium" style={authors?.get(m.author)?.color ? { color: authors.get(m.author)!.color! } : undefined}>
                  {authors?.get(m.author)?.name || m.author.split("@")[0]}:
                </span>{" "}
                {pinText(m)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!p.encrypted && <UnencryptedBanner domain={p.domain} />}
      {p.encrypted && e2ee.phase === "locked" && <LockedNotice />}
      {p.encrypted && e2ee.phase === "joining" && <E2eeStatusLine kind="joining" />}
      {p.encrypted && e2ee.phase === "error" && <E2eeStatusLine kind="error" detail={e2ee.error ?? ""} />}
      {p.encrypted && e2ee.rejoined && <E2eeStatusLine kind="rejoined" />}
      {waiting && <E2eeStatusLine kind="waiting" detail={e2ee.waiting.join(", ")} />}
      {historyLocked && <E2eeStatusLine kind="history" />}
      {p.encrypted && p.room && !threadId && <HistoryRestoreBanner room={p.room} />}
      {gate.warning}
      <VerificationNotice addresses={broken} blocking={verificationBlock} />
      {messages.isError && <p className="p-4 text-sm text-danger">{describeError(messages.error)}</p>}
      <AuthorProfiles messages={loaded} members={p.roomMembers}>
      <PollContext.Provider value={pollEnv}>
      <ComponentsContext.Provider value={componentsEnv}>
      <MessageList
        encrypted={p.encrypted}
        messages={loaded}
        // The simulated member wrote none of these: the viewer's own messages get the menu of anyone else's.
        currentUserId={preview ? undefined : user?.id}
        canManage={p.canManage}
        canReact={p.canReact}
        canPin={p.canPin}
        actions={{ onDelete: remove, onEdit: edit, onReact: react, onPin: pin, onReply: p.readOnlyNote || p.composerNote ? undefined : setReplyTo, onReport: canReport ? setReporting : undefined, onThread: threadId ? undefined : p.onThread }}
        usersById={usersById}
        canStartThreads={!threadId && !!p.canStartThreads}
        currentAddress={user?.address}
        hasMore={!!messages.hasNextPage && !historyCut}
        historyCut={historyCut ? t("roleview.history_start") : undefined}
        loadingOlder={messages.isFetchingNextPage}
        onLoadOlder={loadOlder}
        onAtBottom={() => setPages((old) => trimPages(old))}
        focus={focus}
        hasNewer={detached && !!messages.hasPreviousPage}
        loadingNewer={messages.isFetchingPreviousPage}
        onLoadNewer={() => void messages.fetchPreviousPage()}
        onJumpLatest={jumpLatest}
        roomId={p.roomId}
        customEmojis={customEmojis}
        emojiUrls={emojiUrls}
        decrypted={decrypted}
        signatures={signatures}
        bots={p.bots}
        mentionRoles={mentionRoles}
        authors={authors}
        visibleChannels={visibleChannels}
      />
      </ComponentsContext.Provider>
      </PollContext.Provider>
      </AuthorProfiles>
      {modal && <ComponentModal key={modal.interactionId} modal={modal.modal} appName={modal.application.name} onSubmit={(values) => submitOpenModal(modal, values)} onClose={() => setModal(null)} />}
      <PollComposer open={!!pollComposer} kind={pollComposer?.kind} question={pollComposer?.question} onClose={() => setPollComposer(null)} onCreate={createPoll} />
      {reporting && (
        <ReportDialog
          subject={{ kind: "message", message: reporting, encrypted: reporting.encrypted, candidates: reporting.encrypted ? evidenceCandidates(loaded, decrypted, reporting.id) : [], remoteNode: remoteDirect ? domain : null, roomName: p.room?.name ?? null }}
          client={remoteDirect ? homeApi : api}
          node={remoteDirect ? homeDomain : domain}
          onClose={() => setReporting(null)}
        />
      )}
      <InteractionNotices conversationId={conversationId} qualified={q} encrypted={p.encrypted} mls={e2ee.mls} />
      <TypingIndicator conversationId={conversationId} selfId={user?.id} />
      {p.readOnlyNote || p.composerNote ? (
        <p className="mx-4 mb-4 rounded-md border border-line bg-bg-1 px-3 py-2 text-sm text-fg-2" data-testid={p.readOnlyNote ? "read-only-note" : "composer-note"}>
          {p.readOnlyNote ?? p.composerNote}
        </p>
      ) : (
      <Composer
        placeholder={p.placeholder}
        disabled={!canSendNow}
        disabledReason={canSendNow ? undefined : disabledReason}
        onSend={send}
        encrypted={p.encrypted}
        onTyping={() => {
          // Invisible users appear offline: no typing indicator either; the role preview sends none.
          if (!sendsTyping(usePresence.getState().mine) || preview) return;
          if (p.roomId) socket?.typing(p.roomId, conversationId);
          else socket?.typingIn(conversationId);
        }}
        canAttach={p.canAttach && !preview && (node.data?.policies.uploads_enabled ?? true)}
        // Ciphertext is 16 bytes (GCM tag) larger than the file.
        uploadLimitBytes={uploadLimit && p.encrypted ? uploadLimit - 16 : uploadLimit}
        onUpload={upload}
        gifsEnabled={!!nodeInfo.data?.gif_provider}
        customEmojis={customEmojis}
        commands={commands}
        uploadPolicy={uploadPolicy.data ? toComposerPolicy(uploadPolicy.data) : undefined}
        resolveUploadPolicy={p.canAttach ? resolveUploadPolicy : undefined}
        onPoll={canPoll ? (kind) => setPollComposer({ kind, question: "" }) : undefined}
        above={
          replyTo && (
            <div className="mx-4 flex items-center gap-2 rounded-t-md border border-b-0 border-line bg-bg-1 px-3 py-1 text-xs text-fg-1" data-testid="reply-bar">
              <span className="min-w-0 flex-1 truncate">{t("menu.message.replying_to", { name: authors?.get(replyTo.author)?.name || (replyTo.author.split("@")[0] ?? replyTo.author) })}</span>
              <button type="button" onClick={() => setReplyTo(null)} className="min-h-6 min-w-6 rounded text-fg-2 hover:text-fg-0" aria-label={t("menu.message.cancel_reply")}>
                ×
              </button>
            </div>
          )
        }
      />
      )}
    </div>
    </EmojiContext.Provider>
  );
}
