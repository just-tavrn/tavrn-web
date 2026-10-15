// SPDX-License-Identifier: Apache-2.0
/**
 * Turning incoming messages into notifications (design note 4.11): the decision ({@link decide}), then an
 * entry in the notification center (mentions and DMs), a toast with a jump link, an optional soft sound
 * and, while the tab is in the background, a browser notification ({@link systemNotify}; in the desktop app a
 * native one while its window is not focused). Previews only show plaintext; the content of encrypted messages
 * is never put into a system notification.
 */
import { previewOf } from "../stores/rolePreview";
import { previewHides } from "./previewRoom";
import { plainInEncrypted } from "./unverified";
import { previewText } from "./messagePreview";
import type { QueryClient } from "@tanstack/react-query";
import type { Conversation, Message, RoomDetail } from "@tavrn/sdk";
import { t } from "../i18n";
import { decide, useNotifications } from "../stores/notifications";
import { useToasts } from "../stores/toasts";
import { useMlsUi } from "../stores/mls";
import { isAttentive } from "../hooks/useMarkRead";
import { conversationPath, roomPath } from "../components/NodeScope";
import { channelName } from "./names";
import { apiFor } from "../stores/nodes";
import { onAccountChange } from "../stores/auth";
import { roomOfChannel } from "./roomCache";
import { roomsQuery } from "./queries";
import { useUnread } from "../stores/unread";
import { useThreads } from "../threads/store";
import { platform } from "../platform";

/** Longest preview text. */
const PREVIEW = 140;

/**
 * The text of a plaintext message for previews (null for encrypted or non-text content, and for plaintext in an end-to-end
 * encrypted conversation, which only the node can have put there: ENCRYPTION.md §5.4).
 */
export function plainPreview(m: Pick<Message, "encrypted" | "content">, conversationEncrypted = false): string | null {
  if (m.encrypted || plainInEncrypted(m, conversationEncrypted)) return null;
  const c = m.content as { type?: unknown } | null;
  // Texts and plaintext polls (PROTOCOL.md §7g, read as their question).
  return c?.type === "text" || c?.type === "poll" ? previewText(c, PREVIEW) : null;
}

export interface Located {
  room: RoomDetail | null;
  conversation: Conversation | null;
}

/** Finds the room (detail in the cache) or DM a conversation belongs to. */
export function locate(queryClient: QueryClient, conversationId: string): Located {
  const owner = roomOfChannel(queryClient, conversationId);
  if (owner) return { room: owner.room, conversation: null };
  for (const [, list] of queryClient.getQueriesData<Conversation[]>({ queryKey: ["conversations"] })) {
    const c = Array.isArray(list) ? list.find((x) => x.id === conversationId) : undefined;
    if (c) return { room: null, conversation: c };
  }
  return { room: null, conversation: null };
}

export interface NotifyContext {
  queryClient: QueryClient;
  /** The node the message came from (null = home node). */
  node: string | null;
  me: { id: string; address: string };
  /** Loads the room of that node that holds the conversation when it is unknown (rooms not opened yet). */
  loadRooms?: () => Promise<void>;
  /** The lookup the caller already made (`locate`), so the event costs one. */
  located?: Located;
}

/** Handles a `message.create` for notifications. */
export async function notifyMessage(m: Message, ctx: NotifyContext): Promise<void> {
  let where = ctx.located ?? locate(ctx.queryClient, m.conversation_id);
  if (!where.room && !where.conversation && ctx.loadRooms) {
    await ctx.loadRooms().catch(() => undefined);
    where = locate(ctx.queryClient, m.conversation_id);
  }
  // A DM that started just now: only its node's conversation list is reloaded (shown or not, it is stale now).
  if (!where.room && !where.conversation) {
    await ctx.queryClient.invalidateQueries({ queryKey: ctx.node ? ["conversations", ctx.node] : ["conversations"], exact: true }).catch(() => undefined);
    where = locate(ctx.queryClient, m.conversation_id);
  }
  // Neither a known room channel nor a known DM: nothing sensible to show.
  if (!where.room && !where.conversation) return;
  // A role preview shows nothing of the channels the roles may not view (lib/previewRoom.ts).
  const preview = previewOf(where.room?.id);
  if (where.room && preview && previewHides(where.room, preview.roleIds, m.conversation_id)) return;
  const channel = where.room?.channels.find((c) => c.id === m.conversation_id);
  // A thread message is being read only when its thread is open (PROTOCOL.md §7e).
  const active = (m.thread_id ? useThreads.getState().open === m.thread_id : useMlsUi.getState().open === m.conversation_id) && isAttentive();
  const state = useNotifications.getState();
  const d = decide(state.settings, { conversationId: m.conversation_id, roomId: where.room?.id ?? null, authorId: m.author_id, mentions: m.mentions ?? [], mentionsEveryone: !!m.mentions_everyone, system: channel?.kind === "system" }, ctx.me, { active });
  if (!d.notify) return;
  const author = where.conversation?.members.find((u) => u.address === m.author)?.display_name ?? m.author.split("@")[0] ?? m.author;
  const title = where.room && channel ? t("notify.in_channel", { author, channel: channelName(channel), room: where.room.name }) : where.conversation?.kind === "group" ? t("notify.in_group", { author, group: where.conversation.name || t("notify.group") }) : author;
  // DMs and group DMs are always end-to-end encrypted.
  const conversationEncrypted = !!where.conversation || !!channel?.encrypted;
  const body = plainInEncrypted(m, conversationEncrypted) ? t("messages.not_e2ee_short") : (plainPreview(m, conversationEncrypted) ?? (m.encrypted ? t("notify.encrypted") : t("notify.attachment")));
  const channelPath = where.room ? roomPath(ctx.node, where.room.id, m.conversation_id) : conversationPath(ctx.node, m.conversation_id);
  const path = m.thread_id && where.room ? `${channelPath}/threads/${m.thread_id}` : channelPath;
  if (d.important) useNotifications.getState().push({ kind: where.room ? "mention" : "dm", title, body, path });
  // One toast per conversation or thread (a mention keeps its own): a burst of messages shows the newest, not a stack.
  useToasts.getState().push({ kind: "info", title, detail: body, path, testId: d.important ? "notify-toast-mention" : "notify-toast", tag: `notify:${ctx.node ?? ""}:${m.thread_id ?? m.conversation_id}:${d.important ? "mention" : "message"}` });
  if (state.settings.global.sound) playNotifySound();
  systemNotify({ title, body, tag: m.conversation_id, path }, { browser: state.settings.global.browser });
}

/** Room details fetched for notifications stay fresh this long (the sidebar uses the same entries). */
const ROOM_REFRESH_MS = 30_000;
/** ... and stay cached this long without a view (a busy room the user never opens keeps notifying without lookups). */
const ROOM_KEEP_MS = 30 * 60_000;
/** A conversation no room of the node holds is not looked up again for this long. */
const UNKNOWN_MS = 60_000;
/** Room details fetched at once while looking for a channel's room. */
const ROOM_POOL = 4;
const unknownUntil = new Map<string, number>();
/** One lookup per node at a time: a burst of messages from unknown channels queues instead of fanning out. */
const lookups = new Map<string, Promise<void>>();
/** Loads of every room of a node (no channel to find) run at most every 30 s per node. */
const fullLoads = new Map<string, { at: number; done: Promise<void> }>();

/** Forgets the lookups of the signed-in account (sign-out, tests). */
export function resetRoomLookups(): void {
  unknownUntil.clear();
  lookups.clear();
  fullLoads.clear();
}
onAccountChange(resetRoomLookups);

/**
 * Loads room details of `node` into the cache (`["room", id]`, the entries the sidebar uses; they seed the unread
 * counts too), so channels of rooms the user has not opened yet can be named and their notification settings
 * applied. The room list comes from the shared query; only rooms not cached yet are fetched, four at a time. With
 * `conversationId` the lookup stops at the room that holds it, and a conversation no room holds (a DM) is not looked
 * up again for a minute; without it every room is loaded (folder badges), at most every 30 s per node.
 */
export function loadRoomDetails(queryClient: QueryClient, node: string | null, conversationId?: string): Promise<void> {
  const key = node ?? "";
  if (!conversationId) {
    const known = fullLoads.get(key);
    if (known && Date.now() - known.at < ROOM_REFRESH_MS) return known.done;
  }
  const previous = lookups.get(key) ?? Promise.resolve();
  const done = previous.catch(() => undefined).then(() => findRooms(queryClient, node, conversationId ?? null));
  lookups.set(key, done);
  void done
    .catch(() => undefined)
    .finally(() => {
      if (lookups.get(key) === done) lookups.delete(key);
    });
  if (!conversationId) {
    fullLoads.set(key, { at: Date.now(), done });
    done.catch(() => fullLoads.delete(key));
  }
  return done;
}

async function findRooms(queryClient: QueryClient, node: string | null, conversationId: string | null): Promise<void> {
  const negative = `${node ?? ""}|${conversationId}`;
  if (conversationId && (roomOfChannel(queryClient, conversationId) || (unknownUntil.get(negative) ?? 0) > Date.now())) return;
  const client = apiFor(node);
  const rooms = await queryClient.fetchQuery(roomsQuery(node));
  const pending = rooms.filter((r) => !queryClient.getQueryData(["room", r.id]));
  let next = 0;
  let found = false;
  const worker = async () => {
    while (!found && next < pending.length) {
      const r = pending[next++]!;
      await queryClient
        .fetchQuery({
          queryKey: ["room", r.id],
          queryFn: async () => {
            const room = await client.rooms.get(r.id);
            useUnread.getState().seed(room.read_states ?? []);
            return room;
          },
          staleTime: ROOM_REFRESH_MS,
          gcTime: ROOM_KEEP_MS,
        })
        .catch(() => undefined);
      if (conversationId && roomOfChannel(queryClient, conversationId)) found = true;
    }
  };
  await Promise.all(Array.from({ length: ROOM_POOL }, worker));
  if (conversationId && !found) unknownUntil.set(negative, Date.now() + UNKNOWN_MS);
}

// ---- Sound ----------------------------------------------------------------------------------

let audio: AudioContext | null = null;
let lastSound = 0;

/** A soft two-note chime (sine, gentle envelope, < 300 ms), synthesized like the voice cues; at most one per second. */
export function playNotifySound(): void {
  const now = Date.now();
  if (now - lastSound < 1000) return;
  lastSound = now;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
    const start = audio.currentTime + 0.01;
    [659.25, 880].forEach((freq, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = start + i * 0.11;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.07, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.16);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    });
  } catch {
    /* no audio */
  }
}

// ---- Browser notifications ------------------------------------------------------------------

/** Navigation from a browser notification (set by the app shell). */
let navigateTo: ((path: string) => void) | null = null;
export function setNotificationNavigator(fn: ((path: string) => void) | null) {
  navigateTo = fn;
}

/** Opens a path of the client from a notification (browser or web push, `lib/push.ts`). */
export function navigateFromNotification(path: string): void {
  navigateTo?.(path);
}

export function browserNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Asks for permission; only call this from a user action (a click on the switch). */
export async function requestBrowserPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!browserNotificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// ---- System notifications (browser or desktop app) -----------------------------------------------

const DESKTOP_KEY = "tavrn.desktop.notifications";

/** Desktop app: native notifications are on unless switched off on this device (Settings → Notifications). */
export function desktopNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(DESKTOP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDesktopNotifications(on: boolean): void {
  try {
    if (on) localStorage.removeItem(DESKTOP_KEY);
    else localStorage.setItem(DESKTOP_KEY, "off");
  } catch {
    /* no storage: stays on */
  }
}

/** The client's window has the focus (the desktop app's window, or the visible tab). */
export function windowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * A notification outside the page, besides the in-app toast: in the desktop app a native one while its window is not
 * focused (mentions, DMs, incoming calls); in the browser a browser notification when `browser` (the account's
 * setting) allows it. Returns what was shown.
 */
export function systemNotify(n: { title: string; body: string; tag: string; path: string | null }, opts: { browser: boolean }): "native" | "browser" | "none" {
  const native = platform().notifications;
  if (native) {
    if (!desktopNotificationsEnabled() || windowFocused()) return "none";
    void native.show({ title: n.title, body: n.body, path: n.path }).catch(() => undefined);
    return "native";
  }
  if (!opts.browser) return "none";
  showBrowserNotification(n.title, n.body, n.tag, n.path);
  return "browser";
}

/** Only while the tab is hidden, and only with permission. */
export function showBrowserNotification(title: string, body: string, tag: string, path: string | null): void {
  if (!browserNotificationsSupported() || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  try {
    const n = new Notification(title, { body, tag, icon: "/icon-192.png" });
    n.onclick = () => {
      window.focus();
      if (path) navigateTo?.(path);
      n.close();
    };
  } catch {
    /* some platforms only allow service-worker notifications */
  }
}
