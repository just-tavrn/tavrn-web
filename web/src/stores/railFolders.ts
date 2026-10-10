// SPDX-License-Identifier: Apache-2.0
/**
 * Folders in the room rail (docs/CLIENT.md "Room rail and folders"): rooms grouped into named, optionally coloured
 * folders, and the order of the rail's top-level entries. A per-account client setting kept on this device
 * (local storage, keyed by the account address). The shape is meant to sync through the home node later
 * (TODO: sync through the home node, follow-up): a version number, a flat list of folders with node-qualified room
 * keys and the order of the top-level entries. Which folders are expanded is device state and would stay local.
 *
 * Everything here is pure (state in, state out) except the small store at the end; the rail applies the
 * functions to `materialize(state, homeKeys)` so the order it changes is the order the user sees.
 */
import { create } from "zustand";
import { UNREAD_CAP, type ReadInfo } from "./unread";

/** Version of the stored shape; a newer one (written by a newer client) is not interpreted. */
export const RAIL_STATE_VERSION = 1;
/** Longest folder name (characters). */
export const FOLDER_NAME_MAX = 32;
/** Limits that keep a corrupted or hostile stored value small. */
const MAX_FOLDERS = 100;
const MAX_ROOMS_PER_FOLDER = 200;
const MAX_ORDER = 1000;
const MAX_KEY = 300;

/** The folder colours (decoration only: names, counts and state are never shown by colour alone). */
export const FOLDER_COLORS = ["teal", "blue", "violet", "rose", "amber", "green"] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

export interface RailFolder {
  id: string;
  /** Empty: the rail names the folder after its rooms. */
  name: string;
  color?: FolderColor;
  /** Node-qualified room keys ({@link roomKey}) in display order. */
  roomIds: string[];
}

export interface RailState {
  clientStateVersion: typeof RAIL_STATE_VERSION;
  folders: RailFolder[];
  /** Top-level entries in display order: room keys and folder entries ({@link folderEntry}). */
  order: string[];
  /** Expanded folders (device state). */
  expanded: string[];
}

export const EMPTY_RAIL: RailState = Object.freeze({ clientStateVersion: RAIL_STATE_VERSION, folders: [], order: [], expanded: [] }) as RailState;

/** A room on a node: `<domain>/<room id>` (rooms of several nodes can share a folder). */
export const roomKey = (domain: string, roomId: string) => `${domain}/${roomId}`;
const FOLDER_PREFIX = "folder:";
/** The order entry of a folder. */
export const folderEntry = (id: string) => `${FOLDER_PREFIX}${id}`;
export const isFolderEntry = (entry: string) => entry.startsWith(FOLDER_PREFIX);
export const folderIdOf = (entry: string) => entry.slice(FOLDER_PREFIX.length);

const cleanName = (name: string) => name.trim().slice(0, FOLDER_NAME_MAX);
const isColor = (c: unknown): c is FolderColor => typeof c === "string" && (FOLDER_COLORS as readonly string[]).includes(c);
const isKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= MAX_KEY;
const withColor = (f: Omit<RailFolder, "color">, color: FolderColor | undefined): RailFolder => (color ? { ...f, color } : f);

/** The stored value, validated and repaired (unknown or broken input gives an empty rail). */
export function parseRailState(raw: unknown): RailState {
  if (!raw || typeof raw !== "object") return EMPTY_RAIL;
  const r = raw as Record<string, unknown>;
  if (r.clientStateVersion !== RAIL_STATE_VERSION) return EMPTY_RAIL;
  const folders: RailFolder[] = [];
  const placed = new Set<string>();
  for (const f of Array.isArray(r.folders) ? r.folders.slice(0, MAX_FOLDERS) : []) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (!isKey(o.id) || folders.some((x) => x.id === o.id)) continue;
    const roomIds: string[] = [];
    for (const k of Array.isArray(o.roomIds) ? o.roomIds.slice(0, MAX_ROOMS_PER_FOLDER) : []) {
      if (!isKey(k) || isFolderEntry(k) || placed.has(k)) continue;
      placed.add(k);
      roomIds.push(k);
    }
    folders.push(withColor({ id: o.id, name: typeof o.name === "string" ? cleanName(o.name) : "", roomIds }, isColor(o.color) ? o.color : undefined));
  }
  const ids = new Set(folders.map((f) => f.id));
  const order: string[] = [];
  for (const e of Array.isArray(r.order) ? r.order.slice(0, MAX_ORDER) : []) {
    if (!isKey(e) || order.includes(e)) continue;
    if (isFolderEntry(e) ? !ids.has(folderIdOf(e)) : placed.has(e)) continue;
    order.push(e);
  }
  for (const f of folders) if (!order.includes(folderEntry(f.id))) order.push(folderEntry(f.id));
  const expanded = (Array.isArray(r.expanded) ? r.expanded : []).filter((id, i, all): id is string => typeof id === "string" && ids.has(id) && all.indexOf(id) === i);
  return { clientStateVersion: RAIL_STATE_VERSION, folders, order, expanded };
}

/** The folder a room is in. */
export function folderOf(s: RailState, key: string): RailFolder | undefined {
  return s.folders.find((f) => f.roomIds.includes(key));
}

/**
 * The top-level entries in display order: the stored order first (folders, and rooms of `homeKeys` that are in
 * no folder), then rooms the order does not know yet (new rooms) in the node's order. Rooms of other nodes are
 * shown under their domain, never as top-level entries.
 */
export function topLevel(s: RailState, homeKeys: string[]): string[] {
  const home = new Set(homeKeys);
  const ids = new Set(s.folders.map((f) => f.id));
  const inFolder = new Set(s.folders.flatMap((f) => f.roomIds));
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (e: string) => {
    if (seen.has(e)) return;
    seen.add(e);
    out.push(e);
  };
  for (const e of s.order) {
    if (isFolderEntry(e) ? ids.has(folderIdOf(e)) : home.has(e) && !inFolder.has(e)) add(e);
  }
  for (const k of homeKeys) if (!inFolder.has(k)) add(k);
  for (const f of s.folders) add(folderEntry(f.id));
  return out;
}

/** The state with the visible order stored (the rail applies every change to this). */
export function materialize(s: RailState, homeKeys: string[]): RailState {
  return { ...s, order: topLevel(s, homeKeys) };
}

/** Takes a room out of its folder; a folder emptied this way disappears (with its order entry). */
function detach(s: RailState, key: string): RailState {
  const from = folderOf(s, key);
  if (!from) return { ...s, order: s.order.filter((e) => e !== key) };
  const roomIds = from.roomIds.filter((k) => k !== key);
  if (roomIds.length === 0) {
    return { ...s, folders: s.folders.filter((f) => f.id !== from.id), order: s.order.filter((e) => e !== key && e !== folderEntry(from.id)), expanded: s.expanded.filter((id) => id !== from.id) };
  }
  return { ...s, folders: s.folders.map((f) => (f.id === from.id ? { ...f, roomIds } : f)), order: s.order.filter((e) => e !== key) };
}

/** A new folder at the place of its first top-level room (or at the end), with these rooms. */
export function createFolder(s: RailState, { id, name, color, roomKeys = [] }: { id: string; name: string; color?: FolderColor; roomKeys?: string[] }): RailState {
  if (s.folders.some((f) => f.id === id) || s.folders.length >= MAX_FOLDERS) return s;
  const keys = [...new Set(roomKeys)];
  const at = keys.map((k) => s.order.indexOf(k)).find((i) => i >= 0);
  const order = [...s.order];
  order.splice(at ?? order.length, 0, folderEntry(id));
  let next: RailState = { ...s, order, folders: [...s.folders, withColor({ id, name: cleanName(name), roomIds: [] }, color)] };
  for (const k of keys) next = detach(next, k);
  return { ...next, folders: next.folders.map((f) => (f.id === id ? { ...f, roomIds: keys } : f)) };
}

const updateFolder = (s: RailState, id: string, fn: (f: RailFolder) => RailFolder): RailState => (s.folders.some((f) => f.id === id) ? { ...s, folders: s.folders.map((f) => (f.id === id ? fn(f) : f)) } : s);

export function renameFolder(s: RailState, id: string, name: string): RailState {
  return updateFolder(s, id, (f) => ({ ...f, name: cleanName(name) }));
}

export function setFolderColor(s: RailState, id: string, color: FolderColor | undefined): RailState {
  return updateFolder(s, id, ({ color: _old, ...f }) => withColor(f, isColor(color) ? color : undefined));
}

/** Deletes a folder; its rooms go back to the top level at its place. */
export function deleteFolder(s: RailState, id: string): RailState {
  const folder = s.folders.find((f) => f.id === id);
  if (!folder) return s;
  const entry = folderEntry(id);
  const order = s.order.flatMap((e) => (e === entry ? folder.roomIds : [e]));
  if (!order.includes(folder.roomIds[0] ?? entry)) order.push(...folder.roomIds);
  return { ...s, folders: s.folders.filter((f) => f.id !== id), order, expanded: s.expanded.filter((x) => x !== id) };
}

/** Moves a room into a folder, at `index` (default: the end). */
export function moveToFolder(s: RailState, key: string, folderId: string, index?: number): RailState {
  if (!s.folders.some((f) => f.id === folderId) || isFolderEntry(key)) return s;
  // Within the same folder: only the position changes (the folder must not disappear on the way).
  const same = folderOf(s, key)?.id === folderId;
  const next = same ? { ...s, folders: s.folders.map((f) => (f.id === folderId ? { ...f, roomIds: f.roomIds.filter((k) => k !== key) } : f)) } : detach(s, key);
  return updateFolder(next, folderId, (f) => {
    const roomIds = [...f.roomIds];
    roomIds.splice(Math.max(0, Math.min(index ?? roomIds.length, roomIds.length)), 0, key);
    return { ...f, roomIds };
  });
}

/** Takes a room out of its folder to the top level, right after the folder (or before `before`). */
export function removeFromFolder(s: RailState, key: string, before?: string | null): RailState {
  const folder = folderOf(s, key);
  if (!folder) return s;
  if (before !== undefined) return placeBefore(s, key, before);
  const at = s.order.indexOf(folderEntry(folder.id));
  return placeBefore(s, key, at >= 0 ? (s.order[at + 1] ?? null) : null);
}

/**
 * Moves an entry before `before` (null: to the end of the top level). Before a room inside a folder, a room joins
 * that folder there; a folder goes before that folder instead (folders do not nest).
 */
export function placeBefore(s: RailState, entry: string, before: string | null): RailState {
  if (entry === before) return s;
  const target = before && !isFolderEntry(before) ? folderOf(s, before) : undefined;
  if (target) {
    if (isFolderEntry(entry)) return placeBefore(s, entry, folderEntry(target.id));
    const rest = target.roomIds.filter((k) => k !== entry);
    return moveToFolder(s, entry, target.id, rest.indexOf(before!));
  }
  // Insert first (the source folder's entry still marks the place), then take it out of its folder.
  const order = s.order.filter((e) => e !== entry);
  const at = before ? order.indexOf(before) : -1;
  order.splice(at >= 0 ? at : order.length, 0, entry);
  if (isFolderEntry(entry)) return { ...s, order };
  const from = folderOf(s, entry);
  if (!from) return { ...s, order };
  const detached = detach({ ...s, order: s.order }, entry);
  return { ...detached, order: order.filter((e) => e === entry || detached.order.includes(e)) };
}

/** Moves an entry right after `after` (the drop below an entry): after the last room of a folder it stays inside. */
export function placeAfter(s: RailState, entry: string, after: string): RailState {
  if (entry === after) return s;
  const folder = isFolderEntry(after) ? undefined : folderOf(s, after);
  if (folder) {
    if (isFolderEntry(entry)) return placeAfter(s, entry, folderEntry(folder.id));
    const rest = folder.roomIds.filter((k) => k !== entry);
    return moveToFolder(s, entry, folder.id, rest.indexOf(after) + 1);
  }
  const rest = s.order.filter((e) => e !== entry);
  const at = rest.indexOf(after);
  return placeBefore(s, entry, at >= 0 ? (rest[at + 1] ?? null) : null);
}

/** Moves an entry up (`delta` < 0) or down among its neighbours: in its folder, or on the top level. */
export function shiftEntry(s: RailState, entry: string, delta: number): RailState {
  const folder = isFolderEntry(entry) ? undefined : folderOf(s, entry);
  const list = folder ? folder.roomIds : s.order;
  const from = list.indexOf(entry);
  if (from < 0) return s;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return s;
  const next = [...list];
  next.splice(from, 1);
  next.splice(to, 0, entry);
  return folder ? updateFolder(s, folder.id, (f) => ({ ...f, roomIds: next })) : { ...s, order: next };
}

/**
 * A room dropped onto another room (as on phone home screens): a new folder of both at the target's place; a
 * target inside a folder takes the room into that folder, right after it.
 */
export function combineRooms(s: RailState, dragged: string, target: string, newId: string): RailState {
  if (dragged === target || isFolderEntry(dragged) || isFolderEntry(target)) return s;
  const folder = folderOf(s, target);
  if (folder) {
    const rest = folder.roomIds.filter((k) => k !== dragged);
    return moveToFolder(s, dragged, folder.id, rest.indexOf(target) + 1);
  }
  return createFolder(s, { id: newId, name: "", roomKeys: [target, dragged] });
}

export function toggleExpanded(s: RailState, id: string, value?: boolean): RailState {
  if (!s.folders.some((f) => f.id === id)) return s;
  const open = s.expanded.includes(id);
  const want = value ?? !open;
  if (want === open) return s;
  return { ...s, expanded: want ? [...s.expanded, id] : s.expanded.filter((x) => x !== id) };
}

/**
 * Rooms of `domain` that its room list no longer has (left, deleted) leave the order and the folders. Rooms of
 * other nodes are untouched (a node that cannot be reached keeps its rooms). Folders stay, even empty.
 */
export function pruneRooms(s: RailState, domain: string, roomIds: string[]): RailState {
  const prefix = `${domain}/`;
  const known = new Set(roomIds.map((id) => roomKey(domain, id)));
  const keep = (k: string) => !k.startsWith(prefix) || known.has(k);
  if (s.order.every(keep) && s.folders.every((f) => f.roomIds.every(keep))) return s;
  return { ...s, order: s.order.filter(keep), folders: s.folders.map((f) => (f.roomIds.every(keep) ? f : { ...f, roomIds: f.roomIds.filter(keep) })) };
}

export interface Counts {
  unread: number;
  mentions: number;
  /** The unread messages of rooms whose notification level is "all messages" (shown as a count, not a dot). */
  listed?: number;
}

const cap = (n: number) => Math.min(UNREAD_CAP, n);

/** The unread and mention counts of a room: the sum over its channels. */
export function roomCounts(states: Record<string, ReadInfo>, channelIds: string[]): Counts {
  let unread = 0;
  let mentions = 0;
  for (const id of channelIds) {
    unread += states[id]?.unread ?? 0;
    mentions += states[id]?.mentions ?? 0;
  }
  return { unread: cap(unread), mentions: cap(mentions) };
}

/** A folder's badge: the sum over its rooms. */
export function aggregateCounts(list: Counts[]): Counts {
  const listed = cap(list.reduce((n, c) => n + (c.listed ?? 0), 0));
  return { unread: cap(list.reduce((n, c) => n + c.unread, 0)), mentions: cap(list.reduce((n, c) => n + c.mentions, 0)), ...(listed ? { listed } : {}) };
}

/**
 * What the rail shows bottom right or top right of a room (or a collapsed folder): the mention count (red) when there
 * are mentions; else the unread count (neutral) for rooms whose notification level is "all messages" (`listed`);
 * else an unread dot ("mentions only", muted or nothing, as before).
 */
export type RailBadgeKind = { kind: "mentions"; count: number } | { kind: "unread"; count: number } | { kind: "dot" } | null;

export function railBadge(c: Counts): RailBadgeKind {
  if (c.mentions > 0) return { kind: "mentions", count: c.mentions };
  if ((c.listed ?? 0) > 0) return { kind: "unread", count: c.listed! };
  if (c.unread > 0) return { kind: "dot" };
  return null;
}

// ---- Store ----------------------------------------------------------------------------------

const KEY = "tavrn.rail";

function read(account: string): RailState {
  try {
    const raw = localStorage.getItem(`${KEY}:${account}`);
    return parseRailState(raw ? JSON.parse(raw) : null);
  } catch {
    return EMPTY_RAIL;
  }
}

interface RailStore {
  account: string;
  rail: RailState;
  /** Loads the folders of an account (sign-in, account switch). */
  load: (account: string) => void;
  /** Applies a change and saves it (unchanged state: nothing is written). */
  update: (fn: (s: RailState) => RailState) => void;
  /** A fresh folder id. */
  newId: () => string;
  reset: () => void;
}

export const useRailFolders = create<RailStore>((set, get) => ({
  account: "",
  rail: EMPTY_RAIL,
  load: (account) => {
    if (account === get().account) return;
    set({ account, rail: read(account) });
  },
  update: (fn) => {
    const { rail, account } = get();
    const next = fn(rail);
    if (next === rail) return;
    set({ rail: next });
    if (!account) return;
    try {
      localStorage.setItem(`${KEY}:${account}`, JSON.stringify(next));
    } catch {
      /* storage full or disabled: memory only */
    }
  },
  newId: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `f${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  },
  reset: () => set({ account: "", rail: EMPTY_RAIL }),
}));
