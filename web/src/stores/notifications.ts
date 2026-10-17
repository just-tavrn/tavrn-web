// SPDX-License-Identifier: Apache-2.0
/**
 * Notifications in the client (design note 4.11): the user's settings (global, per room, per channel or DM;
 * all / mentions only / nothing, mute for a while or until turned off, suppress @everyone), kept on the
 * home node (`/users/me/notification-settings`) and mirrored in local storage; nodes without the route
 * (404) keep them in local storage only. Also the notification center: recent mentions, DMs and calls.
 * The decision whether a message notifies is the pure {@link decide}.
 *
 * Local changes are kept as changes, not as a copy: a save applies them onto the settings the node has (the last
 * answer, or a `notifications.update` from another device or tab), so a change made elsewhere is not overwritten.
 * A failed save says so (a toast) and the shown settings go back to what the node has.
 */
import { create } from "zustand";
import { TavrnApiError, type NotificationMode, type NotificationSettings } from "@tavrn/sdk";
import { isHome } from "./nodes";

export type { NotificationMode, NotificationSettings };

/** `muted_until` of "until I turn it back on". */
export const FOREVER = "9999-12-31T00:00:00Z";
/** Entries kept in the notification center. */
export const MAX_ENTRIES = 50;

export const DEFAULT_SETTINGS: NotificationSettings = { global: { mode: "mentions", sound: true, browser: false }, rooms: {}, channels: {} };

const MODES: NotificationMode[] = ["all", "mentions", "nothing"];
const isMode = (v: unknown): v is NotificationMode => typeof v === "string" && (MODES as string[]).includes(v);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Accepts only well-formed values (the stored or served object may come from another client version). */
export function normalizeSettings(raw: unknown): NotificationSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const g = (r.global && typeof r.global === "object" ? r.global : {}) as Record<string, unknown>;
  const out: NotificationSettings = {
    global: {
      mode: isMode(g.mode) ? g.mode : DEFAULT_SETTINGS.global.mode,
      sound: typeof g.sound === "boolean" ? g.sound : true,
      browser: g.browser === true,
      // Web push previews of unencrypted messages (PROTOCOL.md §6d); left out while off, like the node does.
      ...(g.push_text === true ? { push_text: true } : {}),
      // Web push of new reports (PROTOCOL.md §6c): on by default, kept only while off, like the node does.
      ...(g.reports === false ? { reports: false } : {}),
    },
    rooms: {},
    channels: {},
  };
  for (const [id, v] of Object.entries((r.rooms && typeof r.rooms === "object" ? r.rooms : {}) as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== "object") continue;
    const e: NotificationSettings["rooms"][string] = {};
    if (isMode(v.mode)) e.mode = v.mode;
    if (isTime(v.muted_until)) e.muted_until = v.muted_until;
    if (v.suppress_everyone === true) e.suppress_everyone = true;
    if (Object.keys(e).length) out.rooms[id] = e;
  }
  for (const [id, v] of Object.entries((r.channels && typeof r.channels === "object" ? r.channels : {}) as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== "object") continue;
    const e: NotificationSettings["channels"][string] = {};
    if (isMode(v.mode)) e.mode = v.mode;
    if (isTime(v.muted_until)) e.muted_until = v.muted_until;
    if (Object.keys(e).length) out.channels[id] = e;
  }
  return out;
}

/** The `muted_until` of a mute for `hours` (0 = until turned off). */
export function muteUntil(hours: number, now = Date.now()): string {
  return hours > 0 ? new Date(now + hours * 3_600_000).toISOString() : FOREVER;
}

export function mutedNow(until: string | null | undefined, now = Date.now()): boolean {
  return !!until && Date.parse(until) > now;
}

/** The mode in effect: the channel's, else the room's, else the global one; DMs default to every message. */
export function effectiveMode(s: NotificationSettings, roomId: string | null, conversationId: string): NotificationMode {
  const channel = s.channels[conversationId]?.mode;
  if (channel) return channel;
  if (roomId) return s.rooms[roomId]?.mode ?? s.global.mode;
  return s.global.mode === "nothing" ? "nothing" : "all";
}

/**
 * The room's level for its rail badge (docs/CLIENT.md "Room rail and folders"): "all" (every message: the unread
 * count), "mentions" (mentions only: a dot) or "muted" (muted now, or nothing; the rail keeps the dot).
 */
export function roomBadgeLevel(s: NotificationSettings, roomId: string, now = Date.now()): "all" | "mentions" | "muted" {
  if (mutedNow(s.rooms[roomId]?.muted_until, now)) return "muted";
  const mode = s.rooms[roomId]?.mode ?? s.global.mode;
  return mode === "nothing" ? "muted" : mode;
}

/** The inherited mode of a level (what "default" means in the menus). */
export function inheritedMode(s: NotificationSettings, roomId: string | null, level: "room" | "channel"): NotificationMode {
  if (level === "channel" && roomId) return s.rooms[roomId]?.mode ?? s.global.mode;
  if (!roomId) return s.global.mode === "nothing" ? "nothing" : "all";
  return s.global.mode;
}

export interface IncomingMessage {
  conversationId: string;
  /** Null for DMs and group DMs. */
  roomId: string | null;
  authorId: string;
  mentions: string[];
  mentionsEveryone: boolean;
  /** Welcome/system channels never notify. */
  system?: boolean;
}

export interface Decision {
  notify: boolean;
  /** Mentions the user (or @everyone), or a DM: goes into the notification center. */
  important: boolean;
}

/**
 * Should `m` notify `me`? Never for own messages, system channels, muted channels/rooms or the
 * conversation the user is looking at (`active`). DMs count as mentions; @everyone counts unless the room
 * suppresses it.
 */
export function decide(s: NotificationSettings, m: IncomingMessage, me: { id: string; address: string }, opts: { active: boolean; now?: number }): Decision {
  const no = { notify: false, important: false };
  if (m.authorId === me.id || m.system || opts.active) return no;
  const now = opts.now ?? Date.now();
  if (mutedNow(s.channels[m.conversationId]?.muted_until, now)) return no;
  if (m.roomId && mutedNow(s.rooms[m.roomId]?.muted_until, now)) return no;
  const mode = effectiveMode(s, m.roomId, m.conversationId);
  if (mode === "nothing") return no;
  const everyone = m.mentionsEveryone && !(m.roomId && s.rooms[m.roomId]?.suppress_everyone);
  const mentioned = !m.roomId || everyone || m.mentions.map((x) => x.toLowerCase()).includes(me.address.toLowerCase());
  if (mode === "mentions" && !mentioned) return no;
  return { notify: true, important: mentioned };
}

export interface NotificationEntry {
  id: string;
  kind: "mention" | "dm" | "message" | "call" | "legal" | "report" | "history";
  title: string;
  body: string;
  /** Route to jump to. */
  path: string | null;
  /** Message covered by this entry; absent on entries saved by older clients. */
  messageId?: string;
  at: string;
  read: boolean;
}

interface Remote {
  get: () => Promise<NotificationSettings>;
  put: (s: NotificationSettings) => Promise<NotificationSettings>;
}

interface NotificationState {
  settings: NotificationSettings;
  /** Where the settings live: the home node, or this browser only (route missing). */
  source: "loading" | "server" | "local";
  entries: NotificationEntry[];
  /** Loads the settings (on sign-in). */
  load: (remote: Remote, account: string) => Promise<void>;
  /** Changes the settings (saved on the node, debounced, and locally). */
  update: (fn: (s: NotificationSettings) => NotificationSettings) => void;
  /** Sends a pending save now (the page is being left). */
  flush: () => void;
  /** `notifications.update` (another device or tab changed them): taken over, local changes not saved yet stay on top. */
  applyRemote: (settings: unknown) => void;
  push: (entry: Omit<NotificationEntry, "id" | "read" | "at"> & { at?: string }) => void;
  markAllRead: () => void;
  markMessagesRead: (target: { node?: string | null; conversationId?: string; threadId?: string; messageId: string; caughtUp?: boolean }) => void;
  remove: (id: string) => void;
  clear: () => void;
  reset: () => void;
}

const SETTINGS_KEY = "tavrn.notify.settings";
const ENTRIES_KEY = "tavrn.notify.entries";

// A lookup may finish after the user read its message. Keep recent markers until account reset, so a late entry
// does not restore the badge. Routes identify the node as well as the conversation/thread; calls stay independent.
const MAX_READ_MARKERS = 500;
const messageReads = new Map<string, { id: string; caughtUp: boolean }>();
const readKey = (node: string | null, kind: "thread" | "conversation", id: string) => JSON.stringify([node, kind, id]);
function acknowledge(entry: NotificationEntry): NotificationEntry {
  if (entry.read || !["mention", "dm", "message"].includes(entry.kind) || !entry.path) return entry;
  const route = /^(?:\/n\/([^/]+))?\/(?:conversations\/([^/]+)|rooms\/[^/]+\/channels\/([^/]+)(?:\/threads\/([^/]+))?)$/.exec(entry.path);
  if (!route) return entry;
  const marker = messageReads.get(readKey(route[1] ?? null, route[4] ? "thread" : "conversation", (route[4] ?? route[2] ?? route[3])!));
  return marker && (entry.messageId ? entry.messageId <= marker.id : marker.caughtUp) ? { ...entry, read: true } : entry;
}

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled: memory only */
  }
}

let remoteRef: Remote | null = null;
let accountRef = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let counter = 0;
/** The settings as the node has them (last load, answer or event). */
let base: NotificationSettings = DEFAULT_SETTINGS;
/** Local changes not confirmed by the node yet, in order. */
let pending: Array<(s: NotificationSettings) => NotificationSettings> = [];
/** Raises the toast of a failed save (set by the app: keeps the store free of the toast store). */
let onSaveFailed: ((e: unknown) => void) | null = null;

export function setNotificationSaveFailed(fn: ((e: unknown) => void) | null) {
  onSaveFailed = fn;
}

const withPending = (s: NotificationSettings) => pending.reduce((acc, fn) => normalizeSettings(fn(acc)), s);

/** Saves after a short pause (several toggles in a row cost one request). */
const SAVE_DELAY_MS = 400;

export const useNotifications = create<NotificationState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  source: "loading",
  entries: [],
  load: async (remote, account) => {
    remoteRef = remote;
    accountRef = account;
    const local = normalizeSettings(readLocal(`${SETTINGS_KEY}:${account}`));
    const entries = (readLocal<NotificationEntry[]>(`${ENTRIES_KEY}:${account}`) ?? []).slice(0, MAX_ENTRIES).map(acknowledge);
    set({ settings: local, entries });
    writeLocal(`${ENTRIES_KEY}:${account}`, entries);
    try {
      const served = normalizeSettings(await remote.get());
      base = served;
      const settings = withPending(served);
      set({ settings, source: "server" });
      writeLocal(`${SETTINGS_KEY}:${account}`, settings);
    } catch (e) {
      // Nodes without the route keep the settings in this browser.
      set({ source: e instanceof TavrnApiError && (e.status === 404 || e.status === 405) ? "local" : get().source === "loading" ? "local" : get().source });
    }
  },
  update: (fn) => {
    const settings = normalizeSettings(fn(get().settings));
    set({ settings });
    writeLocal(`${SETTINGS_KEY}:${accountRef}`, settings);
    if (get().source !== "server" || !remoteRef) return;
    pending.push(fn);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().flush(), SAVE_DELAY_MS);
  },
  flush: () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const remote = remoteRef;
    if (!remote || !pending.length) return;
    const sent = pending.length;
    const account = accountRef;
    remote
      .put(withPending(base))
      .then((answer) => {
        if (remoteRef !== remote || accountRef !== account) return;
        base = normalizeSettings(answer);
        pending = pending.slice(sent);
        const settings = withPending(base);
        set({ settings });
        writeLocal(`${SETTINGS_KEY}:${account}`, settings);
      })
      .catch((e: unknown) => {
        if (remoteRef !== remote || accountRef !== account) return;
        if (e instanceof TavrnApiError && (e.status === 404 || e.status === 405)) {
          // The node has no route after all: the settings stay in this browser.
          pending = [];
          set({ source: "local" });
          return;
        }
        // Not saved: the shown settings are the node's again (with later changes still waiting), and the user is told.
        pending = pending.slice(sent);
        const settings = withPending(base);
        set({ settings });
        writeLocal(`${SETTINGS_KEY}:${account}`, settings);
        onSaveFailed?.(e);
      });
  },
  applyRemote: (raw) => {
    if (get().source !== "server") return;
    base = normalizeSettings(raw);
    const settings = withPending(base);
    set({ settings });
    writeLocal(`${SETTINGS_KEY}:${accountRef}`, settings);
  },
  push: (entry) => {
    const next = acknowledge({ ...entry, at: entry.at ?? new Date().toISOString(), id: `${Date.now().toString(36)}-${++counter}`, read: false });
    const entries = [next, ...get().entries].slice(0, MAX_ENTRIES);
    set({ entries });
    writeLocal(`${ENTRIES_KEY}:${accountRef}`, entries);
  },
  markAllRead: () => {
    const entries = get().entries.map((e) => (e.read ? e : { ...e, read: true }));
    set({ entries });
    writeLocal(`${ENTRIES_KEY}:${accountRef}`, entries);
  },
  markMessagesRead: ({ node = null, conversationId, threadId, messageId, caughtUp = false }) => {
    const id = threadId ?? conversationId;
    if (!id || !messageId) return;
    const key = readKey(isHome(node) ? null : node, threadId ? "thread" : "conversation", id);
    const previous = messageReads.get(key);
    messageReads.delete(key);
    messageReads.set(key, { id: previous && previous.id > messageId ? previous.id : messageId, caughtUp: caughtUp || !!previous?.caughtUp });
    if (messageReads.size > MAX_READ_MARKERS) messageReads.delete(messageReads.keys().next().value!);
    const old = get().entries;
    const entries = old.map(acknowledge);
    if (entries.every((entry, i) => entry === old[i])) return;
    set({ entries });
    writeLocal(`${ENTRIES_KEY}:${accountRef}`, entries);
  },
  remove: (id) => {
    const entries = get().entries.filter((e) => e.id !== id);
    set({ entries });
    writeLocal(`${ENTRIES_KEY}:${accountRef}`, entries);
  },
  clear: () => {
    set({ entries: [] });
    writeLocal(`${ENTRIES_KEY}:${accountRef}`, []);
  },
  reset: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    remoteRef = null;
    accountRef = "";
    base = DEFAULT_SETTINGS;
    pending = [];
    messageReads.clear();
    set({ settings: DEFAULT_SETTINGS, source: "loading", entries: [] });
  },
}));

// ---- Setters used by the menus and the settings tab ----------------------------------------

export function setRoomSetting(roomId: string, patch: Partial<NotificationSettings["rooms"][string]>) {
  useNotifications.getState().update((s) => ({ ...s, rooms: { ...s.rooms, [roomId]: clean({ ...s.rooms[roomId], ...patch }) } }));
}

export function setChannelSetting(conversationId: string, patch: Partial<NotificationSettings["channels"][string]>) {
  useNotifications.getState().update((s) => ({ ...s, channels: { ...s.channels, [conversationId]: clean({ ...s.channels[conversationId], ...patch }) } }));
}

export function setGlobalSetting(patch: Partial<NotificationSettings["global"]>) {
  useNotifications.getState().update((s) => ({ ...s, global: { ...s.global, ...patch } }));
}

/** Drops nulls (= inherit / not muted). */
function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false)) as T;
}

// A change made right before leaving the page is still sent.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => useNotifications.getState().flush());
