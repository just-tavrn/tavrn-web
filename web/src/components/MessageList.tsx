// SPDX-License-Identifier: Apache-2.0
import { channelName } from "../lib/names";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { isBotKind, type Message, type User } from "@tavrn/sdk";
import { ThreadIndicator } from "../threads/ThreadIndicator";
import { formatFullTime, formatTime } from "../lib/format";
import { MAX_CACHED, PAGE } from "../lib/messagePages";
import { configureMarkdown, handleMarkdownClick, handleMarkdownKey, markdownVersion, renderMarkdown, subscribeMarkdown } from "../lib/markdown";
import { useEmojiResolver } from "../lib/emojis";
import { isGifUrl } from "../lib/gifs";
import { GifView } from "./GifView";
import { useT } from "../i18n";
import { previewText } from "../lib/messagePreview";
import { Avatar } from "./ui";
import { MessageAttachments, fromEncrypted, fromPlain } from "./AttachmentView";
import { ContextMenu, MenuButton, useContextMenu } from "./ContextMenu";
import { messageMenu } from "../lib/menus";
import { mentionsMe } from "../lib/mentions";
import { mentionTokens, parseMentionTokens, serializeMentionTokens } from "../lib/mentionBadges";
import { copyText } from "./ContextMenu";
import { useToasts } from "../stores/toasts";
import { useAccessibility } from "../stores/accessibility";
import { useUnread } from "../stores/unread";
import { EmojiPicker, ReactionBar, type CustomEmoji } from "./Reactions";
import { BotBadge, KeyChangedBadge, SealedMark } from "./Badges";
import { recheckKey } from "../stores/mls";
import { contentAttachments, parsePoll, plainMarker, type ContentAttachment, type Decrypted, type DecryptFailure, type PlainStatus, type Poll } from "@tavrn/e2ee";
import { UnverifiedMarker, VerifiedBadge } from "./Verification";
import { plainInEncrypted, unverifiedStatus } from "../lib/unverified";
import { MediaAvatar } from "./Avatar";
import { useAuthorAvatar } from "./AuthorProfiles";
import { LinkPreviews } from "./LinkPreviews";
import { webOrigin } from "../platform";
import { PollView, UnreadablePoll } from "../polls/PollView";
import { ComponentInteractionLine, ComponentNotices, MessageComponents } from "../messageComponents/MessageComponents";
import { authorKind, componentsOf } from "../messageComponents/model";

/** How an author is shown: nickname or display name, role colour. */
export interface AuthorLook {
  name: string;
  color: string | null;
}

/** `alice` of `alice@node.example` (authors without a member entry). */
const localName = (address: string) => address.split("@")[0] ?? address;

interface AnyContent {
  type?: string;
  body?: unknown;
  by?: string;
  encrypted?: boolean;
  gif?: { url?: string; preview_url?: string; width?: number; height?: number };
}

export interface MessageActions {
  onDelete?: (m: Message) => void;
  onEdit?: (m: Message, body: string) => Promise<void> | void;
  onReact?: (m: Message, emoji: string, active: boolean) => void;
  onPin?: (m: Message, pinned: boolean) => void;
  /** Reply to a message (the composer shows "replying to …"). */
  onReply?: (m: Message) => void;
  /** Report a message of someone else (MODERATION.md); absent where the node takes no reports. */
  onReport?: (m: Message) => void;
  /**
   * Threads (PROTOCOL.md §7e): start a thread from a message (`create`: ask for a title) or answer in its thread
   * (`reply`: open the thread, starting it with a default title when there is none).
   */
  onThread?: (m: Message, mode: "create" | "reply", text: string) => void;
}

/** First guess of a row's height before it is measured (an ungrouped one-line message). */
const ESTIMATED_ROW_PX = 64;
/** Rows rendered beyond the visible ones on each side (smooth scrolling, keyboard focus nearby). */
const OVERSCAN_ROWS = 10;

// Stable defaults: a fresh `{}`/`[]` default would change on every render and defeat the row memo.
const NO_EMOJIS: CustomEmoji[] = [];
const NO_URLS: Record<string, string> = {};
const NO_DECRYPTED: Record<string, Decrypted> = {};
const NO_SIGNATURES: Record<string, PlainStatus> = {};
const NO_ACTIONS: MessageActions = {};

export function MessageList({
  messages,
  currentUserId,
  canManage,
  canReact = false,
  canPin = false,
  onLoadOlder,
  hasMore,
  loadingOlder = false,
  onAtBottom,
  actions = NO_ACTIONS,
  roomId,
  customEmojis = NO_EMOJIS,
  emojiUrls = NO_URLS,
  decrypted = NO_DECRYPTED,
  signatures = NO_SIGNATURES,
  bots,
  mentionRoles,
  currentAddress,
  authors,
  focus,
  hasNewer = false,
  loadingNewer = false,
  onLoadNewer,
  onJumpLatest,
  usersById,
  canStartThreads = false,
  encrypted = false,
  historyCut,
  visibleChannels,
}: {
  /** Newest first, as delivered by the API. */
  messages: Message[];
  /**
   * Role preview (lib/previewRoom.ts): the encrypted history a new member with the role gets starts here; the text
   * replaces "load older" at the top (nothing older is loaded).
   */
  historyCut?: string;
  /** The channels in the viewer's channel list (room channels): welcome channel entries name only these. */
  visibleChannels?: ReadonlySet<string>;
  currentUserId: string | undefined;
  canManage: boolean;
  canReact?: boolean;
  canPin?: boolean;
  onLoadOlder?: () => void;
  hasMore: boolean;
  /** An older page is being fetched. */
  loadingOlder?: boolean;
  /** The user scrolled back to the newest messages (the caller may evict old pages). */
  onAtBottom?: () => void;
  actions?: MessageActions;
  roomId?: string;
  customEmojis?: CustomEmoji[];
  emojiUrls?: Record<string, string>;
  /** Results of decrypting the encrypted messages (message id → content or failure). */
  decrypted?: Record<string, Decrypted>;
  /** Signature checks of plaintext messages (FEDERATION.md §10.3; message id → status). */
  signatures?: Record<string, PlainStatus>;
  /** Addresses of bot accounts (BOT badge). */
  bots?: ReadonlySet<string>;
  /** Names of the room's roles (without @everyone): `@Role` in a message is shown as a mention pill. */
  mentionRoles?: readonly string[];
  /** The user's address on the conversation's node: messages mentioning it are highlighted. */
  currentAddress?: string;
  /**
   * Name and role colour per author address (room channels, like the member list; design note 4.13 item 3).
   * Unknown authors show the address's local part.
   */
  authors?: ReadonlyMap<string, AuthorLook>;
  /** Scroll to this message and highlight it briefly (a search result); `n` repeats a jump to the same message. */
  focus?: { id: string; n: number } | null;
  /** The view was opened in the history (a jump): newer messages than the loaded ones exist. */
  hasNewer?: boolean;
  loadingNewer?: boolean;
  onLoadNewer?: () => void;
  /** Back to the newest messages after a jump (the caller reloads the newest page). */
  onJumpLatest?: () => void;
  /** Room members by user id (avatars under messages that started a thread). */
  usersById?: ReadonlyMap<string, User>;
  /** The user may start threads here (`create_threads`); existing threads open either way. */
  canStartThreads?: boolean;
  /**
   * The conversation is end-to-end encrypted (DMs always, channels with encryption on): a plaintext message in it is
   * shown as a mismatch, never as content (ENCRYPTION.md §5.4).
   */
  encrypted?: boolean;
}) {
  const t = useT();
  configureMarkdown({ spoiler: t("markdown.spoiler"), copy: t("markdown.copy_code"), wrap: t("markdown.wrap_code") });
  const listRef = useRef<HTMLDivElement>(null);
  /** The message being edited (its draft lives in the row). */
  const [editingId, setEditingId] = useState<string | null>(null);
  // `actions` is usually a new object on every render of the caller: rows get stable callbacks that
  // read the current actions from this ref, so a new message renders only its own row.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const onReact = useCallback((m: Message, emoji: string, active: boolean) => actionsRef.current.onReact?.(m, emoji, active), []);
  const onPin = useCallback((m: Message, pinned: boolean) => actionsRef.current.onPin?.(m, pinned), []);
  const onEdit = useCallback(async (m: Message, body: string) => actionsRef.current.onEdit?.(m, body), []);
  // The mention tokens of a row (memoized row prop), once per message object while the bots, the reader and the
  // role names stay the same: not rebuilt for every visible row on every list render.
  const mentionsOf = useMemo(() => {
    const cache = new WeakMap<Message, string>();
    const opts = { bots, self: currentAddress, nodeDomain: currentAddress ? currentAddress.slice(currentAddress.lastIndexOf("@") + 1) : null, roles: mentionRoles };
    return (m: Message) => {
      let s = cache.get(m);
      if (s === undefined) {
        s = serializeMentionTokens(mentionTokens(m, opts));
        cache.set(m, s);
      }
      return s;
    };
  }, [bots, currentAddress, mentionRoles]);
  const onDelete = useCallback((m: Message) => actionsRef.current.onDelete?.(m), []);
  const onReply = useCallback((m: Message) => actionsRef.current.onReply?.(m), []);
  const onReport = useCallback((m: Message) => actionsRef.current.onReport?.(m), []);
  const onThread = useCallback((m: Message, mode: "create" | "reply", text: string) => actionsRef.current.onThread?.(m, mode, text), []);
  /** Is the view at the newest messages? Updated on scroll; new messages only follow when it is. */
  const atBottom = useRef(true);
  const requested = useRef(false);
  const [newBelow, setNewBelow] = useState(false);
  const lastId = messages[0]?.id;
  const lastOwn = messages[0]?.author_id === currentUserId;
  const oldestId = messages.at(-1)?.id;
  /** Oldest first, as shown. */
  const ordered = useMemo(() => [...messages].reverse(), [messages]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  /** "Mark unread" (design note 4.11): from this message on, others' messages count as unread on this device. */
  const onMarkUnread = useCallback(
    (m: Message) => {
      const list = orderedRef.current;
      const i = list.findIndex((x) => x.id === m.id);
      if (i < 0) return;
      const count = list.slice(i).filter((x) => x.author_id !== currentUserId).length;
      useUnread.getState().markUnread(m.conversation_id, list[i - 1]?.id ?? null, count);
    },
    [currentUserId],
  );

  // Only the rows in and near the visible part of the list are in the DOM (design note 9e). Rows have
  // variable heights (markdown, attachments, images that load later): they are measured when they
  // render and re-measured when they change size. `anchorTo: "end"` keeps the view where it is when
  // older messages are prepended and at the bottom when rows at the bottom grow.
  const contentRef = useRef<HTMLDivElement>(null);
  /** Distance of the rows from the top of the scrolling element (padding and the header above them). */
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => setScrollMargin(contentRef.current?.offsetTop ?? 0), [hasMore, ordered.length === 0]);
  const getItemKey = useCallback((i: number) => ordered[i]?.id ?? i, [ordered]);
  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    anchorTo: "end",
  });
  // Without layout (a list that is not displayed, or jsdom in tests) nothing can be measured or scrolled:
  // then every row is rendered in normal flow.
  const [measurable, setMeasurable] = useState(true);
  useLayoutEffect(() => setMeasurable((listRef.current?.clientHeight ?? 0) > 0), []);

  const scrollToBottom = () => {
    virtualizer.scrollToEnd();
    if (!atBottom.current) onAtBottom?.();
    atBottom.current = true;
    setNewBelow(false);
  };
  // Newest message changed: follow it at the bottom (or for own messages), otherwise offer the jump.
  // While following, the loaded window is kept bounded (design note 4.4): beyond MAX_CACHED + PAGE messages
  // the caller is told it may evict old pages, as when the user scrolls back to the bottom.
  useLayoutEffect(() => {
    if (!lastId || hasNewer) return;
    if (atBottom.current || lastOwn) {
      scrollToBottom();
      if (messages.length > MAX_CACHED + PAGE) onAtBottom?.();
    } else setNewBelow(true);
  }, [lastId, lastOwn]);
  // An older page arrived (the virtualizer kept the view in place): allow the next request.
  useLayoutEffect(() => {
    requested.current = false;
  }, [oldestId]);
  useEffect(() => {
    if (!loadingOlder) requested.current = false;
  }, [loadingOlder]);

  const loadOlder = () => {
    if (!hasMore || loadingOlder || requested.current || !onLoadOlder) return;
    requested.current = true;
    onLoadOlder();
  };
  // Newer pages after a jump: one request at a time, when the user reaches the bottom.
  const requestedNewer = useRef(false);
  useEffect(() => {
    if (!loadingNewer) requestedNewer.current = false;
  }, [loadingNewer, lastId]);
  const loadNewer = () => {
    if (!hasNewer || loadingNewer || requestedNewer.current || !onLoadNewer) return;
    requestedNewer.current = true;
    onLoadNewer();
  };

  // A jump to a message: scroll it into the middle of the view and highlight it for a moment.
  const [flash, setFlash] = useState<string | null>(null);
  const focusIndex = focus ? ordered.findIndex((m) => m.id === focus.id) : -1;
  useLayoutEffect(() => {
    if (!focus || focusIndex < 0) return;
    atBottom.current = false;
    setNewBelow(false);
    const scroll = () => {
      const index = orderedRef.current.findIndex((m) => m.id === focus.id);
      if (index < 0) return;
      if (measurable) virtualizer.scrollToIndex(index, { align: "center" });
      // Found by comparison, not by a selector built from the id (it comes from the URL).
      else [...(listRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].find((el) => el.dataset.messageId === focus.id)?.scrollIntoView({ block: "center" });
    };
    scroll();
    // Rows above the target are measured (and decrypted) after the first scroll and move it: aim again a few times
    // while the list settles, unless the user scrolls meanwhile.
    const timers = [60, 200, 450, 900, 1600].map((ms) => setTimeout(scroll, ms));
    const el = listRef.current;
    const userScroll = () => timers.forEach(clearTimeout);
    el?.addEventListener("wheel", userScroll, { passive: true });
    el?.addEventListener("touchstart", userScroll, { passive: true });
    el?.addEventListener("keydown", userScroll);
    setFlash(focus.id);
    const timer = setTimeout(() => setFlash((f) => (f === focus.id ? null : f)), 4000);
    return () => {
      clearTimeout(timer);
      timers.forEach(clearTimeout);
      el?.removeEventListener("wheel", userScroll);
      el?.removeEventListener("touchstart", userScroll);
      el?.removeEventListener("keydown", userScroll);
    };
    // Only when a (new) jump arrives or its target got loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.id, focus?.n, focusIndex >= 0]);
  /** `scrollTop` and `scrollHeight` at the last scroll event, to tell the user scrolling from rows growing. */
  const last = useRef({ top: 0, height: -1 });
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const grew = last.current.height >= 0 && el.scrollHeight > last.current.height;
    const userMoved = el.scrollTop < last.current.top - 1 || !grew;
    last.current = { top: el.scrollTop, height: el.scrollHeight };
    if (bottom && !atBottom.current) {
      setNewBelow(false);
      onAtBottom?.();
    }
    // Only the user leaves the bottom (by scrolling up); rows that grow while the view follows (a message
    // decrypted, an image loaded) do not stop the following.
    if (bottom && !hasNewer) atBottom.current = true;
    else if (userMoved) atBottom.current = false;
    if (el.scrollTop < 80) loadOlder();
    if (hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight < 200) loadNewer();
  };

  // Screen readers (WCAG 4.1.3): a new message of someone else at the end of the open conversation is announced
  // in a polite live region, once it is readable (encrypted ones after decryption); a setting mutes it.
  const announceMessages = useAccessibility((s) => s.announceMessages);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(lastId);
  const newest = messages[0];
  const newestDecrypted = newest?.encrypted ? decrypted[newest.id] : undefined;
  useEffect(() => {
    if (!newest || announced.current === newest.id) return;
    // Older pages and jumps into the history are no arrivals; the first load is not announced either.
    if (!announced.current || newest.id < announced.current || hasNewer) {
      announced.current = newest.id;
      return;
    }
    if (newest.encrypted && !newestDecrypted) return;
    announced.current = newest.id;
    if (!announceMessages || newest.author_id === currentUserId) return;
    const text = plainInEncrypted(newest, encrypted) ? t("messages.not_e2ee_short") : (snippet(newest, newestDecrypted) ?? t("messages.encrypted_short"));
    setAnnouncement(t("a11y.new_message", { author: authors?.get(newest.author)?.name ?? localName(newest.author), text }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest?.id, newestDecrypted]);

  const items: VirtualItem[] = measurable ? virtualizer.getVirtualItems() : ordered.map((m, index) => ({ index, key: m.id, start: 0, end: 0, size: 0, lane: 0 }));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={listRef} onScroll={onScroll} id="messages" tabIndex={-1} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3" data-testid="message-list" data-loaded={messages.length}>
        {/* Always the same height while there are messages, so its change never shifts the rows. */}
        {historyCut ? (
          <div className="mb-3 flex min-h-10 shrink-0 items-center gap-3" data-testid="preview-history-start">
            <span aria-hidden="true" className="h-px flex-1 bg-line-strong" />
            <span className="text-xs font-medium text-fg-1">
              {historyCut}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-line-strong" />
          </div>
        ) : (hasMore || ordered.length > 0) && (
          <div className="mb-3 flex min-h-10 shrink-0 items-center justify-center">
            {hasMore ? (
              <button type="button" onClick={loadOlder} disabled={loadingOlder} className="min-h-10 rounded-md px-3 text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-60">
                {loadingOlder ? t("messages.loading_older") : t("messages.load_older")}
              </button>
            ) : (
              <p className="text-xs text-fg-2" data-testid="history-start">
                {t("messages.history_start")}
              </p>
            )}
          </div>
        )}
        {ordered.length === 0 && <p className="m-auto text-sm text-fg-2">{t("messages.empty")}</p>}
        <div ref={contentRef} role={ordered.length ? "feed" : undefined} aria-label={ordered.length ? t("a11y.messages") : undefined} aria-busy={ordered.length ? loadingOlder || loadingNewer : undefined} className="relative w-full shrink-0" style={measurable ? { height: virtualizer.getTotalSize() } : undefined}>
          {items.map((item) => {
            const m = ordered[item.index]!;
            const prev = ordered[item.index - 1];
            const grouped = !!prev && prev.author_id === m.author_id && !!prev.device_id && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60_000;
            return (
              <article
                key={item.key}
                ref={measurable ? virtualizer.measureElement : undefined}
                data-index={item.index}
                aria-posinset={item.index + 1}
                aria-setsize={hasMore || hasNewer ? -1 : ordered.length}
                data-highlighted={flash === m.id || undefined}
                className={`${measurable ? "absolute left-0 top-0" : ""} w-full rounded-md transition-colors duration-700 ${flash === m.id ? "bg-accent-soft" : ""} ${item.index === 0 ? "" : grouped ? "pt-1" : "pt-4"}`}
                style={measurable ? { transform: `translateY(${item.start - scrollMargin}px)` } : undefined}
              >
                <MessageRow
                  m={m}
                  grouped={grouped}
                  own={m.author_id === currentUserId}
                  bot={!!bots?.has(m.author) || isBotKind(m.author_kind)}
                  author={authors?.get(m.author)}
                  decrypted={m.encrypted ? decrypted[m.id] : undefined}
                  signature={signatures[m.id]}
                  editing={editingId === m.id}
                  setEditingId={setEditingId}
                  canManage={canManage}
                  canReact={canReact}
                  canPin={canPin}
                  roomId={roomId}
                  customEmojis={customEmojis}
                  emojiUrls={emojiUrls}
                  onReact={actions.onReact ? onReact : undefined}
                  onPin={actions.onPin ? onPin : undefined}
                  onEdit={actions.onEdit ? onEdit : undefined}
                  onDelete={actions.onDelete ? onDelete : undefined}
                  onReply={actions.onReply ? onReply : undefined}
                  onReport={actions.onReport ? onReport : undefined}
                  onThread={actions.onThread ? onThread : undefined}
                  usersById={usersById}
                  canStartThreads={canStartThreads}
                  onMarkUnread={onMarkUnread}
                  replyTo={m.reply_to_id ? (byId.get(m.reply_to_id) ?? (m.reply_deleted || (!!oldestId && m.reply_to_id >= oldestId) ? "deleted" : null)) : undefined}
                  replyAuthor={m.reply_to_id ? authors?.get(byId.get(m.reply_to_id)?.author ?? "") : undefined}
                  replyDecrypted={m.reply_to_id ? decrypted[m.reply_to_id] : undefined}
                  conversationEncrypted={encrypted}
                  mentioned={mentionsMe(m, currentAddress) && m.author_id !== currentUserId}
                  mentions={mentionsOf(m)}
                  visibleChannels={visibleChannels}
                />
              </article>
            );
          })}
        </div>
        {hasNewer && (
          <div className="mt-3 flex min-h-10 shrink-0 items-center justify-center">
            <button type="button" onClick={loadNewer} disabled={loadingNewer} className="min-h-10 rounded-md px-3 text-sm text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-60" data-testid="load-newer">
              {loadingNewer ? t("messages.loading_newer") : t("messages.load_newer")}
            </button>
          </div>
        )}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="message-announcer">
        {announcement}
      </div>
      {hasNewer && onJumpLatest && !newBelow && (
        <button type="button" onClick={onJumpLatest} className="absolute bottom-3 left-1/2 min-h-10 -translate-x-1/2 rounded-full bg-accent px-4 text-sm font-medium text-accent-text shadow-lg hover:bg-accent-hover" data-testid="jump-latest">
          {t("messages.jump_latest")} <span aria-hidden="true">↓</span>
        </button>
      )}
      {newBelow && (
        <button type="button" onClick={scrollToBottom} className="absolute bottom-3 left-1/2 min-h-10 -translate-x-1/2 rounded-full bg-accent px-4 text-sm font-medium text-accent-text shadow-lg hover:bg-accent-hover" data-testid="jump-latest">
          {t("messages.jump_latest")} <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}

/** Length of a call: `0:42`, `12:05`, `1:02:09`. */
export function formatCallDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

type Shown =
  | { kind: "text"; body: string; gif?: AnyContent["gif"]; files?: ContentAttachment[]; raw?: Record<string, unknown>; action?: boolean; retired?: boolean }
  | { kind: "system"; text: string }
  | { kind: "member_event"; event: "join" | "leave"; user: string; name: string }
  | { kind: "key_event"; user: string; name: string; rotated: boolean }
  | { kind: "restore_event"; approved: boolean; user: string; name: string; by: string }
  /** `inChannel`: a security notice in the channel it is about (APPLICATIONS.md §3.6), else a welcome channel entry. */
  | { kind: "bot_event"; added: boolean; bot: string; name: string; channel: string; channelId: string; inChannel: boolean; by: string | null; reason: string }
  | { kind: "call_event"; outcome: "missed" | "ended"; by: string; name: string; duration: number }
  | { kind: "cipher" }
  /** A poll (PROTOCOL.md §7g) that passed the shape check. */
  | { kind: "poll"; poll: Poll; raw: Record<string, unknown>; retired?: boolean }
  /** An encrypted poll this member has no key for (from before they joined): only the voter count is shown. */
  | { kind: "poll_unreadable" }
  | { kind: "undecryptable"; reason: DecryptFailure }
  | { kind: "forged" }
  /** Plaintext in an end-to-end encrypted conversation: only the node can have put it there. */
  | { kind: "unencrypted" }
  | { kind: "unknown"; type: string };

function contentOf(m: Message, d: Decrypted | undefined, signature: PlainStatus | undefined, t: ReturnType<typeof useT>, conversationEncrypted = false): Shown {
  if (plainInEncrypted(m, conversationEncrypted)) return { kind: "unencrypted" };
  let c = (m.content ?? {}) as AnyContent;
  let files: ContentAttachment[] | undefined;
  let raw: Record<string, unknown> | undefined;
  if (m.encrypted) {
    if (!d) return { kind: "cipher" };
    // Only polls carry a close time: an unreadable message with one is a poll from before the member joined (§7g).
    if (!d.ok) return d.reason === "missing_key" && m.poll_closes_at ? { kind: "poll_unreadable" } : { kind: "undecryptable", reason: d.reason };
    raw = d.content;
    c = d.content as AnyContent;
    files = contentAttachments(d.content, m.attachments);
    // System messages never come encrypted: only the node writes them, in plaintext.
    if (typeof c.type === "string" && c.type.startsWith("system.")) return { kind: "unknown", type: c.type };
  } else if (m.device_id && plainMarker(signature) === "hidden") {
    // A wrong or reused device signature: the content may be forged and is not shown (§10.3).
    return { kind: "forged" };
  }
  // Sent from a device that was removed later (ENCRYPTION.md §5.2): readable, with a subtle note.
  const retired = !!(d?.ok && d.retired);
  if (c?.type === "text" && typeof c.body === "string") return { kind: "text", body: c.body, gif: isGifUrl(c.gif?.url) ? c.gif : undefined, files, raw, retired };
  // `/me` (PROTOCOL.md §7): like text, shown in italics.
  if (c?.type === "action" && typeof c.body === "string") return { kind: "text", body: c.body, files, raw, action: true, retired };
  // Polls (PROTOCOL.md §7g): one that breaks the shape rules is shown like an unknown type.
  if (c?.type === "poll") {
    const poll = parsePoll(c);
    return poll ? { kind: "poll", poll, raw: raw ?? (c as Record<string, unknown>), retired } : { kind: "unknown", type: "poll" };
  }
  // Welcome channel (design note 4.11): join/leave entries, rendered in the viewer's language.
  if (c?.type === "system.join" || c?.type === "system.leave") {
    const raw = c as AnyContent & { user?: unknown; display_name?: unknown };
    const user = typeof raw.user === "string" ? raw.user : typeof raw.by === "string" ? raw.by : m.author;
    const name = typeof raw.display_name === "string" && raw.display_name ? raw.display_name : (user.split("@")[0] ?? user);
    return { kind: "member_event", event: c.type === "system.join" ? "join" : "leave", user, name };
  }
  // The room's security log (design note 4.13 item 12): a member's identity key changed. Informational: the badge next to
  // it comes from this device's own pin of the key (ENCRYPTION.md §3.3).
  if (c?.type === "system.key_changed") {
    const raw = c as AnyContent & { user?: unknown; display_name?: unknown; rotated?: unknown };
    const user = typeof raw.user === "string" ? raw.user : m.author;
    const name = typeof raw.display_name === "string" && raw.display_name ? raw.display_name : (user.split("@")[0] ?? user);
    return { kind: "key_event", user, name, rotated: raw.rotated === true };
  }
  // A member with `restore_history` decided a request to restore the history after a key reset (ENCRYPTION.md §7b).
  if (c?.type === "system.history_restored" || c?.type === "system.history_restore_denied") {
    const raw = c as AnyContent & { user?: unknown; display_name?: unknown; by?: unknown };
    const user = typeof raw.user === "string" ? raw.user : m.author;
    const name = typeof raw.display_name === "string" && raw.display_name ? raw.display_name : (user.split("@")[0] ?? user);
    return { kind: "restore_event", approved: c.type === "system.history_restored", user, name, by: typeof raw.by === "string" ? raw.by : "?" };
  }
  // The security log names every bot that joins or leaves an encrypted channel's group (design note 4.7): in the welcome
  // channel for channels everyone can view, else as a notice in the channel itself (APPLICATIONS.md §3.6).
  if (c?.type === "system.bot_added" || c?.type === "system.bot_removed") {
    const raw = c as AnyContent & { bot?: unknown; display_name?: unknown; channel?: unknown; channel_name?: unknown; channel_system_name?: unknown; by?: unknown; reason?: unknown };
    const bot = typeof raw.bot === "string" ? raw.bot : m.author;
    const name = typeof raw.display_name === "string" && raw.display_name ? raw.display_name : (bot.split("@")[0] ?? bot);
    const channel = typeof raw.channel_name === "string" ? channelName({ name: raw.channel_name, system_name: typeof raw.channel_system_name === "string" ? raw.channel_system_name : null }) : "?";
    const channelId = typeof raw.channel === "string" ? raw.channel : "";
    const by = typeof raw.by === "string" && raw.by !== bot ? raw.by : null;
    return { kind: "bot_event", added: c.type === "system.bot_added", bot, name, channel, channelId, inChannel: channelId === m.conversation_id, by, reason: typeof raw.reason === "string" ? raw.reason : "" };
  }
  // Calls in DMs and group DMs (VOICE.md §11.2): missed and ended calls, in the viewer's language.
  if (c?.type === "system.call.missed" || c?.type === "system.call.ended") {
    const raw = c as AnyContent & { duration_secs?: unknown };
    const by = typeof raw.by === "string" ? raw.by : m.author;
    const duration = typeof raw.duration_secs === "number" && Number.isFinite(raw.duration_secs) ? Math.max(0, Math.round(raw.duration_secs)) : 0;
    return { kind: "call_event", outcome: c.type === "system.call.missed" ? "missed" : "ended", by, name: by.split("@")[0] ?? by, duration };
  }
  // Content deleted with its author's account (design note 4.14 item 3): the slot stays for replies.
  if (c?.type === "system.deleted") return { kind: "system", text: t("legal.deleted_content") };
  if (c?.type === "system.encryption_changed") return { kind: "system", text: t(c.encrypted ? "messages.system.encryption_on" : "messages.system.encryption_off", { by: c.by ?? "?" }) };
  if (typeof c?.type === "string" && c.type.startsWith("system.")) return { kind: "system", text: c.type };
  return { kind: "unknown", type: String(c?.type ?? "?") };
}

/**
 * Badge of a `system.key_changed` entry: looks the user's key up once (the pin decides: warning while a change is
 * unacknowledged, a soft notice after a rotation with continuity, nothing once acknowledged).
 */
function KeyCheck({ address, at }: { address: string; at: string }) {
  useEffect(() => {
    void recheckKey(address, Date.parse(at) || 0);
  }, [address, at]);
  return <KeyChangedBadge address={address} />;
}

/**
 * The author's avatar (design note 4.9): the still image, animated only while hovered or focused (never on
 * touch); initials while the profile is unknown or has no image. It subscribes to its author's entry of
 * the avatar store ({@link AuthorProfiles}), so a profile change re-renders only these avatars, not the
 * rows. A button: it opens the profile card (the click is handled by `AuthorProfiles`).
 */
/**
 * The row of a system line: an icon, the avatar of whom it is about, the text with its time; the children (reactions,
 * emoji picker, menu) follow the text.
 */
function SystemRow({ icon, who, at, text, rowProps, children }: { icon: string; who: { address: string; name: string }; at: string; text: ReactNode; rowProps: HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string | undefined }; children: ReactNode }) {
  return (
    <div className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1 text-sm text-fg-1 hover:bg-bg-3/60" {...rowProps}>
      <span className="flex w-9 shrink-0 justify-center text-base" aria-hidden="true">
        {icon}
      </span>
      <MessageAvatar address={who.address} name={who.name} small />
      <span className="min-w-0 flex-1">
        {text}
        <time className="ml-2 text-xs text-fg-2" dateTime={at} title={formatFullTime(at)}>
          {formatTime(at)}
        </time>
      </span>
      {children}
    </div>
  );
}

function MessageAvatar({ address, name, small = false }: { address: string; name: string; small?: boolean }) {
  const t = useT();
  const avatar = useAuthorAvatar(address);
  const size = small ? 24 : 36;
  return (
    <button type="button" className="block shrink-0 rounded-full" aria-label={t("profile.open", { name })} data-testid="message-avatar" data-address={address}>
      {avatar?.still ? <MediaAvatar name={name} still={avatar.still} animated={avatar.animated} size={size} /> : <Avatar name={name} size={size} />}
    </button>
  );
}

interface RowProps {
  m: Message;
  /** The conversation is end-to-end encrypted (plaintext in it is a mismatch). */
  conversationEncrypted?: boolean;
  grouped: boolean;
  own: boolean;
  bot: boolean;
  /** Name and colour of the author (room channels). */
  author?: AuthorLook;
  replyAuthor?: AuthorLook;
  decrypted: Decrypted | undefined;
  signature: PlainStatus | undefined;
  editing: boolean;
  setEditingId: (id: string | null) => void;
  canManage: boolean;
  canReact: boolean;
  canPin: boolean;
  roomId?: string;
  customEmojis: CustomEmoji[];
  emojiUrls: Record<string, string>;
  // Stable callbacks (undefined when the caller does not offer the action).
  onReact?: (m: Message, emoji: string, active: boolean) => void;
  onPin?: (m: Message, pinned: boolean) => void;
  onEdit?: (m: Message, body: string) => Promise<void>;
  onDelete?: (m: Message) => void;
  onReply?: (m: Message) => void;
  onReport?: (m: Message) => void;
  onThread?: (m: Message, mode: "create" | "reply", text: string) => void;
  /** Room members by user id (avatars of a thread's participants). */
  usersById?: ReadonlyMap<string, User>;
  canStartThreads?: boolean;
  onMarkUnread: (m: Message) => void;
  /** The message this one replies to (null: not loaded; "deleted": the original is gone; undefined: no reply). */
  replyTo?: Message | null | "deleted";
  replyDecrypted?: Decrypted;
  /** Mentions the user (highlighted). */
  mentioned?: boolean;
  /** The message's mentions with their kinds (`serializeMentionTokens`: a string, so the memoized row compares it). */
  mentions?: string;
  /** The channels in the viewer's channel list (room channels): welcome channel entries name only these. */
  visibleChannels?: ReadonlySet<string>;
}

/** The first line of a message for reply previews. */
function snippet(m: Message, d: Decrypted | undefined): string | null {
  return previewText(m.encrypted ? (d?.ok ? d.content : null) : m.content, 100);
}

/**
 * One message. Memoized: with stable props from the list, a new message (20/s under load) renders only
 * its own row instead of every loaded one (design note 9e).
 */
const MessageRow = memo(function MessageRow({ m, conversationEncrypted = false, grouped, own, bot, author, replyAuthor, decrypted, signature, editing, setEditingId, canManage, canReact, canPin, roomId, customEmojis, emojiUrls, onReact, onPin, onEdit, onDelete, onReply, onReport, onThread, usersById, canStartThreads, onMarkUnread, replyTo, replyDecrypted, mentioned, mentions, visibleChannels }: RowProps) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const c = useMemo(() => contentOf(m, decrypted, signature, t, conversationEncrypted), [m, decrypted, signature, t, conversationEncrypted]);
  const body = c.kind === "text" ? c.body : "";
  const resolve = useEmojiResolver();
  // highlight.js arriving re-renders rows with code blocks.
  const mdVersion = useSyncExternalStore(subscribeMarkdown, markdownVersion);
  const botLabel = t("badge.bot");
  const html = useMemo(
    () => (body ? renderMarkdown(body, emojiUrls, resolve, mentions ? { tokens: parseMentionTokens(mentions), key: mentions, botLabel } : undefined) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [body, emojiUrls, resolve, mdVersion, mentions, botLabel],
  );
  // Custom emojis whose bytes are gone everywhere become a muted `:name:` chip (design note 4.13).
  const markdownRef = useRef<HTMLDivElement>(null);
  const unavailable = t("emoji.unavailable");
  useEffect(() => {
    const el = markdownRef.current;
    if (!el) return;
    const onError = (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("emoji")) return;
      const chip = document.createElement("span");
      chip.className = "emoji-missing";
      chip.title = unavailable;
      chip.dataset.testid = "emoji-missing";
      chip.textContent = img.alt;
      img.replaceWith(chip);
    };
    el.addEventListener("error", onError, true);
    return () => el.removeEventListener("error", onError, true);
  }, [html, unavailable]);
  const onToggleReaction = useCallback((emoji: string, active: boolean) => onReact?.(m, emoji, active), [onReact, m]);
  // Buttons and selects (APPLICATIONS.md §5.10): only on `text` messages of an application's bot device.
  const kind = authorKind(m, bot);
  const fromBot = kind === "bot";
  const componentRows = useMemo(() => (c.kind === "text" && !c.action ? componentsOf(c.raw ?? m.content, kind) : null), [c, kind, m.content]);
  // Webhook messages carry the name the node set (the per-message `username` or the webhook's name); sealed ones
  // carry the per-message `username` inside the box (APPLICATIONS.md §6.1a).
  // A deleted account (design note 4.14): "Deleted user", no avatar, profile, domain or badges.
  const gone = !!m.author_deleted;
  const sealedBy = decrypted?.ok ? decrypted.sealedBy : undefined;
  const name = gone
    ? t("legal.deleted_user")
    : (decrypted?.ok && decrypted.webhookName) || m.webhook?.name || author?.name || localName(m.author);
  // Context menu (design note 4.11): right-click, long press or the ⋯ button.
  const menu = useContextMenu();
  // The welcome channel's entries cannot be deleted by anyone (MODERATION.md §3); no system line can be reported.
  const welcomeEntry = c.kind === "member_event" || c.kind === "key_event" || c.kind === "bot_event" || c.kind === "restore_event";
  const systemLine = welcomeEntry || c.kind === "call_event" || c.kind === "system";
  const startEdit = () => {
    if (c.kind !== "text") return;
    setDraft(c.body);
    setEditingId(m.id);
  };
  const menuEntries = menu.open
    ? messageMenu(
        { own, text: c.kind === "text" ? c.body : null, pinned: !!m.pinned, canPin: canPin && !!onPin, canReact: canReact && !!onReact, canManage, canReply: !!onReply && (c.kind === "text" || c.kind === "cipher" || c.kind === "poll"), canEdit: !!onEdit, canDelete: !!onDelete && !welcomeEntry, canReport: !!onReport && !systemLine && !m.author_deleted, canThread: !!onThread && !!canStartThreads && !m.thread_id && (c.kind === "text" || c.kind === "cipher" || c.kind === "poll"), hasThread: !!onThread && !!m.thread },
        {
          reply: () => onReply?.(m),
          createThread: () => onThread?.(m, "create", body),
          replyInThread: () => onThread?.(m, "reply", body),
          react: (emoji) => onReact?.(m, emoji, !!m.reactions?.some((r) => r.emoji === emoji && r.me)),
          copyText: () => void copyText(c.kind === "text" ? c.body : "").then((ok) => ok && useToasts.getState().push({ kind: "info", title: t("menu.copied") })),
          copyLink: () => void copyText(`${webOrigin()}${window.location.pathname}?message=${m.id}`).then((ok) => ok && useToasts.getState().push({ kind: "info", title: t("menu.copied") })),
          copyId: () => void copyText(m.id).then((ok) => ok && useToasts.getState().push({ kind: "info", title: t("menu.copied") })),
          pin: (pinned) => onPin?.(m, pinned),
          edit: startEdit,
          remove: () => onDelete?.(m),
          markUnread: () => onMarkUnread(m),
          report: () => onReport?.(m),
        },
        t,
      )
    : [];

  // System lines (member, key, history restore and bot events) share one row: icon, avatar, text and time, reactions.
  const systemRow = (icon: string, who: { address: string; name: string }, data: { [data: `data-${string}`]: string | undefined }, text: ReactNode) => (
    <SystemRow icon={icon} who={who} at={m.created_at} text={text} rowProps={{ ...data, "data-message-id": m.id, ...menu.triggerProps }}>
      <ReactionBar reactions={m.reactions ?? []} canReact={canReact} roomId={roomId} customEmojis={customEmojis} onToggle={onToggleReaction} conversationId={m.conversation_id} messageId={m.id} usersById={usersById} />
      {canReact && onReact && <EmojiPicker customEmojis={customEmojis} onPick={(e) => onReact(m, e, false)} />}
      {menu.open && menu.anchor && <ContextMenu entries={menuEntries} anchor={menu.anchor} onClose={menu.close} label={t("menu.message.label")} testId="message-menu" />}
    </SystemRow>
  );
  if (c.kind === "member_event") return systemRow(c.event === "join" ? "→" : "←", { address: c.user, name: c.name }, { "data-testid": "member-event", "data-event": c.event }, t(c.event === "join" ? "members.joined_room" : "members.left_room", { name: c.name }));
  if (c.kind === "key_event") {
    return systemRow("🔑", { address: c.user, name: c.name }, { "data-testid": "key-event", "data-rotated": c.rotated ? "true" : "false" }, (
      <>
        {t(c.rotated ? "members.key_rotated" : "members.key_changed", { name: c.name })} <KeyCheck address={c.user} at={m.created_at} />
      </>
    ));
  }
  if (c.kind === "restore_event") return systemRow(c.approved ? "🗝" : "⛔", { address: c.user, name: c.name }, { "data-testid": "restore-event", "data-event": c.approved ? "restored" : "denied" }, t(c.approved ? "members.history_restored" : "members.history_restore_denied", { name: c.name, by: c.by }));
  if (c.kind === "bot_event") {
    const reasonKey = `members.bot_reason.${c.reason}`;
    const reason = t(reasonKey) === reasonKey ? c.reason : t(reasonKey);
    // A welcome channel entry names its channel only when the viewer can see it (an older entry about a channel that
    // became private, or no channel list known): "a private channel" otherwise (APPLICATIONS.md §3.6).
    const hidden = !c.inChannel && !visibleChannels?.has(c.channelId);
    const key = c.inChannel
      ? c.added ? (c.by ? "members.bot_reads_channel_by" : "members.bot_reads_channel") : "members.bot_stopped_reading"
      : `${c.added ? (c.by ? "members.bot_added_by" : "members.bot_added") : "members.bot_removed"}${hidden ? "_private" : ""}`;
    const text = t(key, { name: c.name, channel: c.channel, by: c.by ?? "", reason });
    return systemRow("🤖", { address: c.bot, name: c.name }, { "data-testid": c.inChannel ? "bot-notice" : "bot-event", "data-event": c.added ? "added" : "removed", "data-reason": c.added ? undefined : c.reason, "data-hidden-channel": hidden ? "true" : undefined }, (
      <>
        {text} <BotBadge />
      </>
    ));
  }

  if (c.kind === "call_event") {
    const missed = c.outcome === "missed";
    return (
      <div className="group flex items-center gap-3 rounded-md px-2 py-1 text-sm text-fg-1 hover:bg-bg-3/60" data-testid="call-event" data-outcome={c.outcome} data-message-id={m.id} {...menu.triggerProps}>
        <span className={`flex w-9 shrink-0 justify-center text-base ${missed ? "text-danger" : "text-ok"}`} aria-hidden="true">
          {missed ? "📵" : "📞"}
        </span>
        <span className="min-w-0 flex-1">
          {missed ? t("calls.system.missed", { name: c.name }) : t("calls.system.ended", { name: c.name, duration: formatCallDuration(c.duration) })}
          <time className="ml-2 text-xs text-fg-2" dateTime={m.created_at} title={formatFullTime(m.created_at)}>
            {formatTime(m.created_at)}
          </time>
        </span>
        {menu.open && menu.anchor && <ContextMenu entries={menuEntries} anchor={menu.anchor} onClose={menu.close} label={t("menu.message.label")} testId="message-menu" />}
      </div>
    );
  }

  if (c.kind === "system") {
    return (
      <div className="py-1 text-center text-xs text-fg-2" data-testid="system-message">
        {c.text}
      </div>
    );
  }
  return (
    <div className={`group relative rounded-md px-2 hover:bg-bg-3/60 ${grouped ? "py-0.5" : "py-1"} ${m.pinned ? "border-l-2 border-accent" : mentioned ? "border-l-2 border-warn bg-warn/10" : ""}`} data-testid="message" data-message-id={m.id} data-mentioned={mentioned || undefined} {...menu.triggerProps}>
      {replyTo !== undefined && (
        <div className="mb-0.5 ml-12 flex min-w-0 items-center gap-1 text-xs text-fg-2" data-testid="reply-reference">
          <span aria-hidden="true">↱</span>
          {replyTo === "deleted" ? (
            <span className="italic" data-testid="reply-deleted">{t("messages.reply_deleted")}</span>
          ) : replyTo ? (
            <>
              <span className="shrink-0 font-medium text-fg-1" style={replyAuthor?.color ? { color: replyAuthor.color } : undefined}>
                {replyTo.author_deleted ? t("legal.deleted_user") : replyAuthor?.name || localName(replyTo.author)}
              </span>
              <span className="min-w-0 truncate">{plainInEncrypted(replyTo, conversationEncrypted) ? t("messages.not_e2ee_short") : (snippet(replyTo, replyDecrypted) ?? t("messages.encrypted_short"))}</span>
            </>
          ) : (
            <span className="italic">{t("menu.message.reply_unloaded")}</span>
          )}
        </div>
      )}
      {m.interaction && (m.interaction.command ? (
        // The answer to an application command (APPLICATIONS.md §5.7): who used which command.
        <div className="mb-0.5 ml-12 flex min-w-0 items-center gap-1 text-xs text-fg-2" data-testid="message-interaction" data-command={m.interaction.command}>
          <span aria-hidden="true">↱</span>
          <span className="min-w-0 truncate">{t("interactions.used", { user: localName(m.interaction.user), command: m.interaction.command })}</span>
        </div>
      ) : (
        // The answer to a component or a modal (§5.10.3): who used the application, with the way to its message.
        <ComponentInteractionLine interaction={m.interaction} app={name} />
      ))}
      <div className="flex gap-3">
        <div className="w-9 shrink-0 pt-0.5">
          {!grouped &&
            (gone ? (
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-3 text-fg-2" aria-hidden="true" data-testid="deleted-avatar">
                ?
              </span>
            ) : (
              <MessageAvatar address={m.author} name={name} />
            ))}
        </div>
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="flex items-baseline gap-2">
              <span className={`font-semibold ${gone ? "italic text-fg-2" : "text-fg-0"}`} style={author?.color && !gone ? { color: author.color } : undefined} data-testid="message-author" data-author-name data-deleted={gone || undefined}>
                {name}
              </span>
              {!gone && (
                <>
                  <span className="text-xs text-fg-2" title={m.author}>
                    {m.author.includes("@") ? `@${m.author.split("@")[1]}` : ""}
                  </span>
                  {bot && <BotBadge kind={m.author_kind} />}
                  {sealedBy && <SealedMark by={sealedBy} />}
                  <KeyChangedBadge address={m.author} />
                  <VerifiedBadge address={m.author} />
                </>
              )}
              <time className="text-xs text-fg-2" dateTime={m.created_at} title={formatFullTime(m.created_at)}>
                {formatTime(m.created_at)}
              </time>
              {m.pinned && (
                <span role="img" className="text-xs text-accent" title={t("channel.pinned")} aria-label={t("channel.pinned")}>
                  📌
                </span>
              )}
            </div>
          )}
          {c.kind === "text" && editing ? (
            <form
              className="mt-1 space-y-1"
              data-testid="message-editor"
              onSubmit={async (e) => {
                e.preventDefault();
                const next = draft.trim();
                if (!next) return;
                try {
                  await onEdit?.(m, next);
                } catch {
                  // Reported by the conversation (toast): the editor stays open with the new text.
                  return;
                }
                setEditingId(null);
              }}
            >
              <textarea
                aria-label={t("messages.edit_text")}
                value={draft}
                autoFocus
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingId(null);
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                className="w-full rounded-md border border-line-strong bg-bg-0 px-2 py-1 text-sm text-fg-0 outline-none focus:border-accent"
              />
              <div className="flex gap-2 text-xs">
                <button type="submit" className="min-h-8 rounded-md bg-accent px-2 text-accent-text hover:bg-accent-hover">
                  {t("messages.edit_save")}
                </button>
                <button type="button" onClick={() => setEditingId(null)} className="min-h-8 rounded-md px-2 text-fg-2 hover:bg-bg-3">
                  {t("messages.edit_cancel")}
                </button>
              </div>
            </form>
          ) : (
            html && (
              <div
                ref={markdownRef}
                className={`markdown break-words text-fg-0 ${c.kind === "text" && c.action ? "italic" : ""}`}
                data-testid={c.kind === "text" && c.action ? "action-message" : undefined}
                onClick={(e) => {
                  // Spoilers and code block buttons (design note 4.13) live in the rendered HTML.
                  if (handleMarkdownClick(e.target, (text) => void copyText(text).then((ok) => ok && useToasts.getState().push({ kind: "info", title: t("menu.copied") })))) e.stopPropagation();
                }}
                onKeyDown={(e) => handleMarkdownKey(e)}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )
          )}
          {c.kind === "text" && c.gif?.url && <GifView gif={{ url: c.gif.url, width: c.gif.width, height: c.gif.height }} author={m.author} own={own} inRoom={!!roomId} />}
          {c.kind === "text" && !editing && <LinkPreviews body={c.body} content={c.raw ?? m.content} />}
          {componentRows && !editing && <MessageComponents m={m} rows={componentRows} />}
          {fromBot && <ComponentNotices m={m} />}
          {c.kind === "cipher" && <p className="text-sm italic text-fg-2">{t("messages.encrypted")}</p>}
          {c.kind === "poll" && <PollView poll={c.poll} raw={c.raw} m={m} own={own} canManage={canManage} />}
          {c.kind === "poll_unreadable" && <UnreadablePoll m={m} />}
          {c.kind === "undecryptable" && (
            <p className="text-sm italic text-fg-2" title={t(`messages.undecryptable.${c.reason}`)} data-testid="undecryptable" data-reason={c.reason}>
              ⚠ {t(`messages.undecryptable_short.${c.reason}`)} <span className="sr-only">({t(`messages.undecryptable.${c.reason}`)})</span>
            </p>
          )}
          {c.kind === "forged" && (
            <p className="text-sm italic text-danger" title={t("messages.signature_invalid_hint")} data-testid="signature-invalid">
              ⚠ {t("messages.signature_invalid")} <span className="sr-only">({t("messages.signature_invalid_hint")})</span>
            </p>
          )}
          {c.kind === "unencrypted" && (
            <p className="text-sm italic text-danger" data-testid="message-unencrypted">
              ⚠ {t("messages.not_e2ee")}
            </p>
          )}
          {c.kind === "unknown" && <p className="text-sm italic text-fg-2">{t("messages.unknown_type", { type: c.type })}</p>}
          {m.edited_at && c.kind === "text" && <span className="text-xs text-fg-2">{t("messages.edited")}</span>}
          {(c.kind === "text" || c.kind === "poll") && c.retired && (
            <span className={`text-xs text-fg-2 ${m.edited_at ? "ml-1" : ""}`} title={t("messages.retired_device_hint")} data-testid="retired-device">
              ⓘ {t("messages.retired_device")}
            </span>
          )}
          {/* Webhook and unsigned bot messages are authenticated by the node (badges), never marked "unverified". */}
          {(c.kind === "text" || c.kind === "poll") && unverifiedStatus(m, signature, bot) && (
            <span className={m.edited_at ? "ml-1" : ""}>
              <UnverifiedMarker status={unverifiedStatus(m, signature, bot)!} />
            </span>
          )}
          {m.encrypted
            ? c.kind === "text" && !!c.files?.length && <MessageAttachments items={c.files.map((f) => fromEncrypted(f, m.attachments))} author={m.author} own={own} inRoom={!!roomId} />
            : c.kind !== "forged" && c.kind !== "unencrypted" && !!m.attachments?.length && <MessageAttachments items={m.attachments.map(fromPlain)} author={m.author} own={own} inRoom={!!roomId} />}
          <ReactionBar reactions={m.reactions ?? []} canReact={canReact} roomId={roomId} customEmojis={customEmojis} onToggle={onToggleReaction} conversationId={m.conversation_id} messageId={m.id} usersById={usersById} />
          {m.thread && onThread && <ThreadIndicator summary={m.thread} usersById={usersById} onOpen={() => onThread(m, "reply", body)} />}
        </div>
        {/* The hover actions float over the row's top right corner instead of taking a column of the layout (an
            invisible column cost the text a third of a phone's width). Hidden ones ignore the pointer, so a tap on
            the text below never hits an invisible button; keyboard focus shows them. Plain `:hover` on purpose
            (Tailwind's group-hover only applies on devices with a hover pointer): on touch screens a tap on a
            message makes it the hovered one, so its actions appear and the next tap reaches them. */}
        <div className="pointer-events-none absolute right-1 top-0.5 z-10 flex items-start gap-0.5 rounded-md border border-line bg-bg-1 p-0.5 opacity-0 shadow-sm focus-within:pointer-events-auto focus-within:opacity-100 [.group:hover_&]:pointer-events-auto [.group:hover_&]:opacity-100" data-testid="message-actions">
          {canReact && onReact && <EmojiPicker customEmojis={customEmojis} onPick={(e) => onReact(m, e, false)} />}
          {canPin && onPin && (
            <button type="button" aria-label={m.pinned ? t("messages.unpin") : t("messages.pin")} onClick={() => onPin(m, !m.pinned)} className="min-h-8 min-w-8 rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0">
              📌
            </button>
          )}
          {own && c.kind === "text" && onEdit && (
            <button type="button" aria-label={t("messages.edit")} onClick={startEdit} className="min-h-8 min-w-8 rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0">
              ✎
            </button>
          )}
          {(own || canManage) && onDelete && (
            <button type="button" aria-label={t("messages.delete")} onClick={() => onDelete(m)} className="min-h-8 min-w-8 rounded text-fg-2 hover:bg-bg-3 hover:text-danger">
              🗑
            </button>
          )}
          <MenuButton menu={menu} label={t("menu.message.open")} testId="message-menu-button" />
        </div>
      </div>
      {menu.open && menu.anchor && <ContextMenu entries={menuEntries} anchor={menu.anchor} onClose={menu.close} label={t("menu.message.label")} testId="message-menu" />}
    </div>
  );
});
