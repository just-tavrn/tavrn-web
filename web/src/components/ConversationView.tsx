// SPDX-License-Identifier: Apache-2.0
import { ghostNoBots } from "../lib/botAccess";
import { useLabelledGhosts } from "../lib/leafCleanup";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import type { Attachment, Member, Message, RoomDetail } from "@tavrn/sdk";
import { useTyping } from "../stores/typing";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { useNode } from "./NodeScope";
import { useT } from "../i18n";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { EmojiContext, useEmojiUrlMap, useRoomEmojis, type EmojiContextValue } from "../lib/emojis";
import { Permission, hasPermission } from "@tavrn/sdk";
import { useMlsUi } from "../stores/mls";
import { useMarkRead } from "../hooks/useMarkRead";
import { MESSAGE_QUERY_OPTIONS, PAGE, fetchPage, flatten, isDetached, mapMessages, newerParam, olderParam, prependMessage, trimPages, type MessagePages, type PageParam } from "../lib/messagePages";
import { indexEntry, indexMessages } from "../search/local";
import { rememberRoom } from "../search/sync";
import { SearchButton } from "../search/SearchPanel";
import { useDecrypted, useE2eeConversation, usePlainSignatures } from "../hooks/useE2eeConversation";
import { encryptAttachment, encryptCommandArgs, grantsHistory, parseHistoryPolicy, qualify, signedAttachments, type ContentAttachment } from "@tavrn/e2ee";
import { historyPending, historyReceive } from "../crypto/history";
import { MessageList, type AuthorLook } from "./MessageList";
import { memberColor, memberName } from "../lib/memberGroups";
import { Composer, type ComposerCommands, type SendPayload } from "./Composer";
import { availableCommands, builtinRegistry } from "../commands/registry";
import { CommandError, executeBuiltin, resolveAppArgs } from "../commands/execute";
import { appDefinitions, mergePalette } from "../commands/merge";
import type { ArgValue, CommandDefinition } from "../commands/types";
import { useInteractions } from "../stores/interactions";
import { InteractionNotices } from "./InteractionNotices";
import { fuzzyFilter } from "../commands/fuzzy";
import { classifyFile, declaredCategory } from "../lib/uploads";
import { UnencryptedBanner } from "./UnencryptedBanner";
import { E2eeStatusLine, GhostWarning, LockedNotice } from "./E2eeNotices";
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
  const typing = useTyping((s) => s.byChannel[conversationId]);
  const node = useQuery({ queryKey: home ? ["well-known"] : ["well-known", domain], queryFn: () => api.node.wellKnown(), staleTime: 10 * 60_000 });
  const nodeInfo = useQuery({ queryKey: home ? ["node"] : ["node", domain], queryFn: () => api.node.info(), staleTime: 10 * 60_000 });
  const messageKey = useMemo(() => ["messages", conversationId], [conversationId]);
  // Lazy history (design note 4.4): newest page on open, older pages on demand; dropped when closed.
  const messages = useInfiniteQuery({
    queryKey: messageKey,
    queryFn: ({ pageParam }) => fetchPage(api, conversationId, pageParam),
    initialPageParam: undefined as PageParam,
    getNextPageParam: (last) => olderParam(last),
    // After a jump into the history (`around`): newer pages up to the live end.
    getPreviousPageParam: (first, _all, firstParam) => newerParam(first, firstParam),
    // Kept current by the WebSocket, dropped when closed, no structural sharing (keeps message identities).
    ...MESSAGE_QUERY_OPTIONS,
  });
  const loaded = useMemo(() => flatten(messages.data), [messages.data]);
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
  const ghostAck = useMlsUi((s) => !!s.ghostAck[conversationId]);
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
  const uploadPolicy = useQuery({ queryKey: ["upload-policy", domain, conversationId], queryFn: () => api.attachments.policy(conversationId), enabled: p.canAttach, staleTime: 60_000 });

  // MLS names the conversation by its qualified id: the node hosting it and the ULID (ENCRYPTION.md §0.1).
  const q = qualify(domain, conversationId);
  // Room channels with an effective "no bots" flag: bot leaves are ghosts (APPLICATIONS.md §3.5). The client also
  // applies the room's `bots_in_encrypted_channels` itself (design note 4.7).
  const noBots = ghostNoBots(p.room?.channels.find((c) => c.id === conversationId), p.room);
  const e2ee = useE2eeConversation({ conversationId: q, encrypted: p.encrypted, canCreate: p.canSend, members: p.members, direct: p.direct, mayManage: p.mayManage, refreshMembers: p.refreshMembers, noBots });
  // Leaves of deleted devices read "removed, cleanup pending" instead of "unknown device" (ENCRYPTION.md §4.7).
  const ghosts = useLabelledGhosts(q, e2ee.ghosts);
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
  useEffect(() => {
    if (p.roomId && e2ee.phase === "ready") void rememberRoom(q, p.roomId);
  }, [q, p.roomId, e2ee.phase]);

  // Jump to a message (`?m=<id>`, a search result): load the page around it unless it is loaded already.
  const focusParam = new URLSearchParams(location.search).get("m")?.toUpperCase() ?? null;
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!focusParam) return;
    let cancelled = false;
    void (async () => {
      const current = queryClient.getQueryData<MessagePages<Message>>(messageKey);
      if (!current?.pages.some((page) => page.some((m) => m.id === focusParam))) {
        try {
          const page = await api.conversations.messages(conversationId, { limit: PAGE, around: focusParam });
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
  const authors = useMemo(() => {
    if (!p.roomMembers) return undefined;
    const map = new Map<string, AuthorLook>();
    for (const m of p.roomMembers) map.set(m.user.address, { name: memberName(m), color: roles ? memberColor(m, roles) : null });
    return map;
  }, [p.roomMembers, roles]);
  const verificationBlock = !!p.direct && broken.length > 0;

  // History for new members (ENCRYPTION.md §7b): room channels whose policy gives members older messages.
  const historyPolicy = useMemo(() => {
    const channel = p.room?.channels.find((c) => c.id === conversationId);
    return channel && p.encrypted ? parseHistoryPolicy(channel.history_for_new_members) : null;
  }, [p.room, conversationId, p.encrypted]);
  const historyActive = !!historyPolicy && grantsHistory(historyPolicy) && e2ee.phase === "ready";
  const historyPendingList = useQuery({
    queryKey: ["history-pending", domain, conversationId],
    queryFn: () => api.history.pending(conversationId),
    enabled: historyActive,
    staleTime: 30_000,
  });
  const historyLocked = historyActive && !!historyPendingList.data?.items.some((i) => i.user === user?.address);
  useEffect(() => {
    if (!historyActive || !historyPolicy) return;
    // Keys shared while this device was away, then members who still wait for ours.
    void historyReceive(q).then((n) => {
      if (n > 0) void queryClient.invalidateQueries({ queryKey: ["history-pending", domain, conversationId] });
    });
    historyPending(q, historyPolicy);
  }, [historyActive, historyPolicy, q, domain, conversationId, queryClient]);

  useEffect(() => {
    useMlsUi.setState({ open: conversationId });
    return () => useMlsUi.setState((s) => (s.open === conversationId ? { open: null } : s));
  }, [conversationId]);
  useMarkRead(conversationId, loaded[0]?.id);

  const ready = !p.encrypted || e2ee.phase === "ready" || e2ee.phase === "no_group";
  const waiting = p.encrypted && e2ee.waiting.length > 0;
  const ghostBlock = p.encrypted && e2ee.ghosts.length > 0 && !ghostAck;
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

  const typingNames = Object.keys(typing ?? {}).filter((id) => id !== user?.id);
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

  const upload = async (file: File, onProgress: (f: number) => void): Promise<Attachment> => {
    if (!p.encrypted) {
      const stored = await api.attachments.uploadToConversation(conversationId, file, file.name, onProgress);
      uploads.current.set(stored.id, stored);
      return stored;
    }
    // §6: encrypt locally, upload only ciphertext; name, type and key go into the encrypted content. The
    // category is declared (PROTOCOL.md §7a): the node cannot see the file.
    const category = declaredCategory(await classifyFile(file));
    const { blob, meta } = await encryptAttachment(file);
    const stored = await api.attachments.uploadToConversation(conversationId, blob, "", onProgress, category);
    if (stored.sha256 !== meta.sha256) throw new Error(t("attachment.upload_mismatch"));
    uploadKeys.current.set(stored.id, { id: stored.id, ...meta });
    return stored;
  };

  /** Plaintext content or `{ content, epoch }` of the encrypted content object. */
  const seal = async (content: Record<string, unknown>): Promise<{ content: unknown; epoch?: number }> => {
    if (!p.encrypted) return { content };
    if (!e2ee.mls) throw new Error(t("e2ee.composer_locked"));
    return e2ee.mls.encrypt(q, content);
  };

  const send = async ({ body, attachmentIds, gif, preview, spoilerIds }: SendPayload) => {
    const content: Record<string, unknown> = { type: "text", body: body || (gif ? "" : "📎") };
    if (gif) content.gif = { url: gif.url, preview_url: gif.preview_url, width: gif.width, height: gif.height };
    // The sender's link preview travels in the content (encrypted with it in E2EE, signed with it in plaintext).
    if (preview) content.preview = fitPreview(content, preview, p.encrypted);
    await deliver(content, attachmentIds, spoilerIds);
  };
  /** Seals, signs and sends a content object (text, `/me` actions) with the given uploads (some as spoilers). */
  const deliver = async (content: Record<string, unknown>, attachmentIds: string[] = [], spoilerIds: string[] = []) => {
    try {
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
      const sealed = await seal(content);
      // Plaintext: device signature over the envelope fields and the content (FEDERATION.md §10.3),
      // best effort (no device key yet: unsigned).
      let signature: string | null = null;
      if (!p.encrypted && e2ee.mls) {
        const files = attachmentIds.map((id) => uploads.current.get(id));
        if (files.every((f) => !!f)) {
          signature = e2ee.mls.signPlaintext(q, { reply_to: reply, thread_id: null, mentions_everyone, mentions, attachments: signedAttachments(files as Attachment[]) }, content);
        }
      }
      const spoilers = !p.encrypted && spoilerIds.length ? { spoilers: spoilerIds.filter((id) => attachmentIds.includes(id)) } : {};
      const created = await api.conversations.send(conversationId, { ...sealed, attachments: attachmentIds, mentions, mentions_everyone, reply_to_id: reply, ...spoilers, ...(signature ? { signature } : {}) });
      setReplyTo(null);
      for (const id of attachmentIds) {
        uploadKeys.current.delete(id);
        uploads.current.delete(id);
      }
      setPages((old) => prependMessage(old, created));
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
      const previous = m.encrypted ? (decrypted[m.id]?.ok ? (decrypted[m.id] as { content: Record<string, unknown> }).content : null) : (m.content as Record<string, unknown>);
      if (!previous) return;
      const next = { ...previous, type: previous.type === "action" ? "action" : "text", body };
      const sealed = await seal(next);
      // Edits are signed anew by the editing device (§10.3); the bound attachments stay.
      const signature = !p.encrypted && e2ee.mls
        ? e2ee.mls.signPlaintext(q, { reply_to: m.reply_to_id ?? null, thread_id: m.thread_id ?? null, mentions_everyone: m.mentions_everyone, mentions: m.mentions, attachments: signedAttachments(m.attachments ?? []) }, next)
        : null;
      updateMessage(await api.conversations.edit(conversationId, m.id, { ...sealed, mentions: m.mentions, mentions_everyone: m.mentions_everyone, ...(signature ? { signature } : {}) }));
    } catch (e) {
      toastError(e);
      throw e;
    }
  };
  const remove = async (m: Message) => {
    if (!confirm(t("messages.delete_confirm"))) return;
    try {
      await api.conversations.deleteMessage(conversationId, m.id);
      setPages((old) => mapMessages(old, (page) => page.filter((x) => x.id !== m.id)));
    } catch (e) {
      toastError(e);
    }
  };
  // Application commands of this conversation (APPLICATIONS.md §5.4), when the node offers them.
  const commandsOffered = !!nodeInfo.data?.capabilities?.includes("commands.v1");
  const palette = useQuery({
    queryKey: ["commands", domain, conversationId],
    queryFn: () => api.commands.palette(conversationId),
    enabled: commandsOffered && p.canSend && !p.readOnlyNote,
    staleTime: 60_000,
  });
  const appCommands = useMemo(() => appDefinitions(palette.data), [palette.data]);
  /** Invokes an application command; the answer is a message, an ephemeral reply, "thinking…" or an error notice. */
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
    const res = await api.commands.invoke(conversationId, { command: def.ref, ...sealed });
    const notices = useInteractions.getState();
    if (res.message) {
      const m = res.message;
      setPages((old) => prependMessage(old, m));
    } else if (res.ephemeral) {
      const r = res.ephemeral;
      notices.add({ interactionId: r.interaction_id, conversationId, kind: "ephemeral", application: r.application, content: r.content, epoch: r.epoch, deviceId: r.device_id });
    } else if (res.outcome === "defer") {
      notices.add({ key: `${res.interaction_id}:thinking`, interactionId: res.interaction_id, conversationId, kind: "thinking", application: def.application });
    } else if (res.outcome === "error") {
      notices.add({ interactionId: res.interaction_id, conversationId, kind: "error", application: def.application, text: res.error ?? "" });
    }
  };
  const invokeRef = useRef(invokeApp);
  invokeRef.current = invokeApp;
  // Slash commands (design note 4.11): built-ins filtered by the user's permissions here, then application commands.
  const registry = useMemo(() => builtinRegistry(), []);
  const hasVoice = !!p.room?.channels.some((c) => c.kind === "voice");
  const commands = useMemo<ComposerCommands>(() => {
    const scope = { permissions: p.permissions ?? 0n, direct: !p.roomId, hasVoice };
    const available = mergePalette(availableCommands(registry, scope), appCommands, scope);
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
            confirm: (text) => window.confirm(text),
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
  }, [registry, appCommands, p.permissions, p.roomId, p.room, p.roomMembers, hasVoice, conversationId, domain, user?.domain, location.pathname]);

  const emojiContext = useMemo<EmojiContextValue>(() => ({ domain, roomId: p.roomId, externalAllowed, roomEmojis: emojiList }), [domain, p.roomId, externalAllowed, emojiList]);

  const loadOlder = () => {
    if (!messages.hasNextPage || messages.isFetchingNextPage) return;
    void messages.fetchNextPage();
  };

  const pinText = (m: Message): string => {
    const c = m.encrypted ? (pinDecrypted[m.id]?.ok ? (pinDecrypted[m.id] as { content: Record<string, unknown> }).content : null) : (m.content as Record<string, unknown> | null);
    if (m.encrypted && !c) return t("messages.encrypted_short");
    return typeof c?.body === "string" ? c.body : t("channel.attachment");
  };

  return (
    <EmojiContext.Provider value={emojiContext}>
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        {p.header}
        {p.encrypted && (
          <span role="img" className="shrink-0 text-xs text-fg-2" title={t("e2ee.encrypted_hint")} aria-label={t("e2ee.encrypted_hint")} data-testid="encrypted-marker">
            🔒
          </span>
        )}
        <span className="flex-1" />
        <SearchButton conversationId={conversationId} encrypted={p.encrypted} roomId={p.roomId} room={p.room} members={p.roomMembers} />
        <WhiteboardButton conversationId={conversationId} encrypted={p.encrypted} />
        <button type="button" aria-label={t("channel.pins")} aria-pressed={showPins} onClick={() => setShowPins((v) => !v)} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0 aria-pressed:bg-accent-soft aria-pressed:text-accent">
          📌
        </button>
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
      {p.encrypted && <GhostWarning ghosts={ghosts} acknowledged={ghostAck} onAcknowledge={() => useMlsUi.setState((s) => ({ ghostAck: { ...s.ghostAck, [conversationId]: true } }))} />}
      <VerificationNotice addresses={broken} blocking={verificationBlock} />
      {messages.isError && <p className="p-4 text-sm text-danger">{describeError(messages.error)}</p>}
      <AuthorProfiles messages={loaded}>
      <MessageList
        messages={loaded}
        currentUserId={user?.id}
        canManage={p.canManage}
        canReact={p.canReact}
        canPin={p.canPin}
        actions={{ onDelete: remove, onEdit: edit, onReact: react, onPin: pin, onReply: p.readOnlyNote ? undefined : setReplyTo, onReport: canReport ? setReporting : undefined }}
        currentAddress={user?.address}
        hasMore={!!messages.hasNextPage}
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
        authors={authors}
      />
      </AuthorProfiles>
      {reporting && (
        <ReportDialog
          subject={{ kind: "message", message: reporting, encrypted: reporting.encrypted, candidates: reporting.encrypted ? evidenceCandidates(loaded, decrypted, reporting.id) : [], remoteNode: remoteDirect ? domain : null, roomName: p.room?.name ?? null }}
          client={remoteDirect ? homeApi : api}
          node={remoteDirect ? homeDomain : domain}
          onClose={() => setReporting(null)}
        />
      )}
      <InteractionNotices conversationId={conversationId} qualified={q} encrypted={p.encrypted} mls={e2ee.mls} />
      <div className="h-5 px-4 text-xs text-fg-2" aria-live="polite" data-testid="typing-indicator">
        {typingNames.length === 1 && t("messages.typing_one")}
        {typingNames.length > 1 && t("messages.typing_many", { count: typingNames.length })}
      </div>
      {p.readOnlyNote ? (
        <p className="mx-4 mb-4 rounded-md border border-line bg-bg-1 px-3 py-2 text-sm text-fg-2" data-testid="read-only-note">
          {p.readOnlyNote}
        </p>
      ) : (
      <Composer
        placeholder={p.placeholder}
        disabled={!canSendNow}
        disabledReason={canSendNow ? undefined : disabledReason}
        onSend={send}
        onTyping={() => (p.roomId ? socket?.typing(p.roomId, conversationId) : socket?.typingIn(conversationId))}
        canAttach={p.canAttach && (node.data?.policies.uploads_enabled ?? true)}
        // Ciphertext is 16 bytes (GCM tag) larger than the file.
        uploadLimitBytes={uploadLimit && p.encrypted ? uploadLimit - 16 : uploadLimit}
        onUpload={upload}
        gifsEnabled={!!nodeInfo.data?.gif_provider}
        customEmojis={customEmojis}
        commands={commands}
        uploadPolicy={uploadPolicy.data ? { allowed: uploadPolicy.data.allowed_categories, executablesAllowed: uploadPolicy.data.executables_allowed } : undefined}
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
