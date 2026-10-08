// SPDX-License-Identifier: Apache-2.0
/**
 * The room rail: the narrow bar on the far left (home, rooms, folders, rooms of other nodes, create, discover).
 *
 * Folders (docs/CLIENT.md "Room rail and folders", state in `stores/railFolders.ts`): a folder is a disclosure
 * button (`aria-expanded`) whose rooms are a nested list of links, so the rooms stay links for every assistive
 * technology. Keyboard: Tab or ↑/↓ (Home/End) move through the rail, → expands a folder or enters it, ← collapses it
 * or goes back to it, Enter/Space toggle a folder, the context-menu key or Shift+F10 open the menus. Every drag and
 * drop action (HTML5 drag and drop with a mouse) has a menu entry, so touch and keyboard reach all of them; on touch
 * nothing is draggable and a long press opens the menus.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type DragEvent, type KeyboardEvent, type TouchEvent } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useLocation, useNavigate } from "react-router";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { useT } from "../i18n";
import { useShell } from "./AppShell";
import { RoomIcon } from "./Avatar";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { BrandIcon } from "./auth/Brand";
import { roomPath } from "./NodeScope";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { Button, Dialog, Field, Input } from "./ui";
import { useConversations } from "../pages/DirectMessages";
import { formatCount, useUnread } from "../stores/unread";
import { apiFor, isHome, useNodes } from "../stores/nodes";
import { useReach } from "../stores/reach";
import { useConversationIndex } from "../stores/conversationIndex";
import { useRoomMenu } from "./menus/RoomMenu";
import { loadRoomDetails } from "../lib/notify";
import { railFolderMenu, railMenu, railRoomEntries, type Shift } from "../lib/railMenus";
import {
  FOLDER_COLORS,
  FOLDER_NAME_MAX,
  combineRooms,
  createFolder,
  deleteFolder,
  folderEntry,
  folderIdOf,
  isFolderEntry,
  materialize,
  moveToFolder,
  placeAfter,
  placeBefore,
  pruneRooms,
  removeFromFolder,
  renameFolder,
  roomCounts,
  roomKey,
  setFolderColor,
  shiftEntry,
  toggleExpanded,
  topLevel,
  useRailFolders,
  type Counts,
  type FolderColor,
  type RailFolder,
  type RailState,
} from "../stores/railFolders";

interface RailRoomData {
  id: string;
  name: string;
  icon?: string | null;
  icon_still?: string | null;
}

/** A room in the rail with its node (null: the home node) and its key in the folder state. */
interface Resolved {
  key: string;
  room: RailRoomData;
  node: string | null;
}

/** The decorative folder colours (≥ 3:1 against the rail background as the glyph colour of an expanded folder). */
const COLOR_HEX: Record<FolderColor, string> = { teal: "#33aea6", blue: "#5b8ae0", violet: "#9a78de", rose: "#d8698a", amber: "#d39a3a", green: "#45b980" };

type DropMode = "before" | "after" | "into" | "end";
interface Drop {
  target: string;
  mode: DropMode;
}

interface RailContextValue {
  /** Applies a change to the visible state; `focus`: the entry that takes the focus afterwards (it may move). */
  change: (fn: (s: RailState) => RailState, focus?: string) => void;
  folders: { id: string; label: string }[];
  activeKey: string | null;
  openDialog: (d: FolderDialogState) => void;
  dragging: string | null;
  drop: Drop | null;
  canDrag: boolean;
  setDragging: (key: string | null) => void;
  setDrop: (d: Drop | null) => void;
  commit: (target: string, mode: DropMode) => void;
}

const RailContext = createContext<RailContextValue | null>(null);
const useRail = () => useContext(RailContext)!;

type FolderDialogState = { mode: "new"; roomKey?: string } | { mode: "rename"; folder: RailFolder };

/** Touch-first devices: no dragging (a long press opens the menus there). */
function coarsePointer(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** Events from a portal (an open menu) bubble through the React tree but not through the DOM. */
const fromPortal = (e: { currentTarget: EventTarget; target: EventTarget }) => !(e.currentTarget as Node).contains(e.target as Node);

/** The room detail query (shared with the sidebar and the room menu): its channels give the room's counts. */
function detailQuery(node: string | null, roomId: string) {
  return {
    queryKey: ["room", roomId],
    queryFn: async () => {
      const r = await apiFor(node).rooms.get(roomId);
      useUnread.getState().seed(r.read_states ?? []);
      return r;
    },
    staleTime: 30_000,
    // Never fetched for the rail: the counts come with details loaded elsewhere (opened rooms, notifications).
    enabled: false,
  };
}

/** Unread and mention counts summed over rooms (from their cached details and the unread store). */
function useCounts(rooms: Resolved[]): Counts {
  const details = useQueries({ queries: rooms.map((r) => detailQuery(r.node, r.room.id)) });
  const channelIds = details.flatMap((d) => (d.data?.channels ?? []).filter((c) => c.kind !== "voice").map((c) => c.id));
  const unread = useUnread((s) => roomCounts(s.states, channelIds).unread);
  const mentions = useUnread((s) => roomCounts(s.states, channelIds).mentions);
  return { unread, mentions };
}

/** Mention count (it takes precedence) or an unread dot; the text alternative is on the item itself. */
function RailBadge({ counts }: { counts: Counts }) {
  if (counts.mentions > 0)
    return (
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-1 -right-1 h-5 min-w-5 rounded-full border-2 border-bg-0 bg-danger-solid px-1 text-center text-[11px] font-semibold leading-4 text-white" data-testid="rail-mention-badge">
        {formatCount(counts.mentions)}
      </span>
    );
  if (counts.unread > 0) return <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-bg-0 bg-accent" data-testid="rail-unread-dot" />;
  return null;
}

/** The drop indicator line above or below an entry (accent on the rail background: 6.97:1). */
function DropLine({ at }: { at: "before" | "after" }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute left-1 right-1 h-1 rounded-full bg-accent ${at === "before" ? "-top-1.5" : "-bottom-1.5"}`} data-testid="rail-drop-indicator" data-at={at} />;
}

function countsText(t: ReturnType<typeof useT>, c: Counts): string | null {
  if (c.mentions > 0) return t("unread.mentions", { count: formatCount(c.mentions) });
  if (c.unread > 0) return t("dm.unread");
  return null;
}

/**
 * Drag source and drop target handlers of an entry. `between`: drops above/below reorder; `into`: a drop on the
 * middle joins (a folder) or combines (a room).
 */
function useDragTarget(key: string, { between, into }: { between: boolean; into: boolean }) {
  const { dragging, setDragging, setDrop, commit, canDrag } = useRail();
  const modeAt = (e: DragEvent): DropMode | null => {
    if (!dragging || dragging === key) return null;
    const folder = isFolderEntry(dragging);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rel = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    if (between && rel < 0.25) return "before";
    if (between && rel > 0.75) return "after";
    if (into && !folder) return "into";
    if (between) return rel < 0.5 ? "before" : "after";
    return null;
  };
  return {
    draggable: canDrag,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-tavrn-rail", key);
      setDragging(key);
    },
    onDragOver: (e: DragEvent) => {
      const mode = modeAt(e);
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDrop({ target: key, mode });
    },
    onDrop: (e: DragEvent) => {
      const mode = modeAt(e);
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      commit(key, mode);
    },
    onDragEnd: () => {
      setDragging(null);
      setDrop(null);
    },
  };
}

/** A room in the rail with its context menu (right-click, long press, keyboard; design note 4.11). */
function RailRoom({ entry, title, label, dimmed = false, folderId = null, shift, between }: { entry: Resolved; title: string; label: string; dimmed?: boolean; folderId?: string | null; shift: Shift; between: boolean }) {
  const t = useT();
  const { change, folders, openDialog, drop } = useRail();
  const { key, room, node } = entry;
  const extra = railRoomEntries(
    { folders, current: folderId, shift },
    {
      moveTo: (id) => change((s) => moveToFolder(s, key, id), key),
      newFolder: () => openDialog({ mode: "new", roomKey: key }),
      remove: () => change((s) => removeFromFolder(s, key), key),
      up: () => change((s) => shiftEntry(s, key, -1), key),
      down: () => change((s) => shiftEntry(s, key, 1), key),
    },
    t,
  );
  const { menu, overlay } = useRoomMenu(room, node, extra);
  const counts = useCounts([entry]);
  const drag = useDragTarget(key, { between, into: true });
  const target = drop?.target === key ? drop.mode : null;
  return (
    <>
      <NavLink
        to={roomPath(node, room.id)}
        title={title}
        aria-label={label}
        aria-description={countsText(t, counts) ?? undefined}
        data-testid="rail-room"
        data-room={room.id}
        data-rail-key={key}
        data-rail-nav=""
        data-rail-item=""
        data-in-folder={folderId ?? undefined}
        {...menu.triggerProps}
        {...drag}
        className={({ isActive }) => `relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-all ${isActive ? "rounded-xl ring-2 ring-accent" : "hover:rounded-xl"} ${target === "into" ? "rounded-xl ring-2 ring-accent ring-offset-2 ring-offset-bg-0" : ""} ${dimmed ? "opacity-50" : ""}`}
      >
        <RoomIcon room={room} size={44} node={node} />
        <RailBadge counts={counts} />
        {(target === "before" || target === "after") && <DropLine at={target} />}
      </NavLink>
      {overlay}
    </>
  );
}

/** A folder: a disclosure button with up to four mini icons; expanded, its rooms follow as a nested list. */
function RailFolderItem({ folder, rooms, expanded, shift }: { folder: RailFolder; rooms: Resolved[]; expanded: boolean; shift: Shift }) {
  const t = useT();
  const { change, activeKey, openDialog, drop } = useRail();
  const menu = useContextMenu();
  const listId = useId();
  const entry = folderEntry(folder.id);
  const counts = useCounts(rooms);
  const display = folderDisplayName(t, folder, rooms);
  const holdsActive = !!activeKey && folder.roomIds.includes(activeKey);
  const parts = [t("rail.folder.label", { name: display }), rooms.length === 1 ? t("rail.folder.rooms_one") : t("rail.folder.rooms", { count: rooms.length })];
  const text = countsText(t, counts);
  if (text) parts.push(text);
  if (holdsActive && !expanded) parts.push(t("rail.folder.selected"));
  const drag = useDragTarget(entry, { between: true, into: true });
  const target = drop?.target === entry ? drop.mode : null;
  const color = folder.color ? COLOR_HEX[folder.color] : null;
  const toggle = () => change((s) => toggleExpanded(s, folder.id), entry);
  const entries = menu.open
    ? railFolderMenu(
        { expanded, color: folder.color, shift },
        {
          toggle,
          rename: () => openDialog({ mode: "rename", folder }),
          setColor: (c) => change((s) => setFolderColor(s, folder.id, c), entry),
          up: () => change((s) => shiftEntry(s, entry, -1), entry),
          down: () => change((s) => shiftEntry(s, entry, 1), entry),
          remove: () => change((s) => deleteFolder(s, folder.id), folder.roomIds[0]),
        },
        t,
      )
    : [];
  const selected = holdsActive && !expanded;
  return (
    <li className="relative flex w-full flex-col items-center" data-testid="rail-folder" data-folder={folder.id} data-expanded={expanded || undefined}>
      <div className={`flex flex-col items-center gap-2 ${expanded ? "w-14 rounded-2xl bg-bg-2 pb-1" : ""}`}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={parts.join(", ")}
          title={display}
          data-testid="rail-folder-button"
          data-rail-key={entry}
          data-rail-nav=""
          data-rail-item=""
          data-folder-button={folder.id}
          data-selected={selected || undefined}
          {...menu.triggerProps}
          {...drag}
          onClick={toggle}
          className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-all hover:rounded-xl ${color ? "" : "bg-bg-3"} ${selected ? "rounded-xl ring-2 ring-accent" : ""} ${target === "into" ? "rounded-xl ring-2 ring-accent ring-offset-2 ring-offset-bg-0" : ""}`}
          style={color && !expanded ? { background: `color-mix(in srgb, ${color} 40%, var(--color-bg-0))` } : undefined}
        >
          {expanded ? (
            <FolderGlyph color={color} />
          ) : (
            <span aria-hidden="true" className="grid h-10 w-10 grid-cols-2 place-items-center gap-0.5">
              {rooms.slice(0, 4).map((r) => (
                <RoomIcon key={r.key} room={r.room} size={18} node={r.node} testId="rail-folder-icon" />
              ))}
            </span>
          )}
          {!expanded && <RailBadge counts={counts} />}
          {(target === "before" || target === "after") && <DropLine at={target} />}
        </button>
        {expanded && (
          <ul id={listId} aria-label={t("rail.folder.rooms_in", { name: display })} className="flex flex-col items-center gap-2" data-testid="rail-folder-rooms">
            {rooms.map((r, i) => (
              <li key={r.key} className="relative">
                <RailRoom entry={r} title={r.node ? `${r.room.name} · ${r.node}` : r.room.name} label={r.node ? `${r.room.name} (${r.node})` : r.room.name} folderId={folder.id} between shift={{ up: i > 0, down: i < rooms.length - 1 }} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label={t("menu.label", { name: display })} testId="folder-menu" />}
    </li>
  );
}

function FolderGlyph({ color }: { color: string | null }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="26" height="26" className={color ? "" : "text-fg-1"} style={color ? { color } : undefined} data-testid="rail-folder-glyph">
      <path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.4.6L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function folderDisplayName(t: ReturnType<typeof useT>, folder: RailFolder, rooms: Resolved[]): string {
  if (folder.name) return folder.name;
  const names = rooms.map((r) => r.room.name);
  if (!names.length) return t("rail.folder.untitled");
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}, …` : names.join(", ");
}

/** "New folder…" and "Rename…": a name and an optional colour from the palette. */
function FolderDialog({ state, onClose, onSubmit }: { state: FolderDialogState; onClose: () => void; onSubmit: (name: string, color: FolderColor | undefined) => void }) {
  const t = useT();
  const initial = state.mode === "rename" ? state.folder : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<FolderColor | undefined>(initial?.color);
  const legend = useId();
  return (
    <Dialog title={t(state.mode === "new" ? "rail.dialog.new_title" : "rail.dialog.rename_title")} open onClose={onClose}>
      <form
        className="space-y-4"
        data-testid="folder-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name, color);
        }}
      >
        <Field label={t("rail.dialog.name")} hint={t("rail.dialog.name_hint")}>
          <Input name="folder-name" value={name} maxLength={FOLDER_NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <div role="radiogroup" aria-labelledby={legend} className="space-y-1 text-sm">
          <span id={legend} className="block text-fg-1">
            {t("rail.dialog.color")}
          </span>
          <div className="flex flex-wrap gap-1">
            {[undefined, ...FOLDER_COLORS].map((c) => (
              <label key={c ?? "none"} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-2 ${color === c ? "border-accent bg-accent-soft text-fg-0" : "border-line text-fg-1 hover:bg-bg-3"}`}>
                <input type="radio" name="folder-color" value={c ?? ""} checked={color === c} onChange={() => setColor(c)} />
                <span aria-hidden="true" className="h-4 w-4 rounded-full border border-line" style={{ background: c ? COLOR_HEX[c] : "var(--color-bg-3)" }} />
                {t(`rail.color.${c ?? "none"}`)}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit">{t(state.mode === "new" ? "rail.dialog.create" : "rail.dialog.save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Rooms of another node in the rail: always under its domain (design note 9d), unless they are in a folder. The
 * list comes from that node; while it cannot be reached, the rooms known from the index stay visible and marked.
 */
function NodeRoomGroup({ domain, rooms }: { domain: string; rooms: Resolved[] }) {
  const t = useT();
  const unreachable = useReach((s) => s.nodes[domain] === "unreachable");
  if (!rooms.length) return null;
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="node-group" data-node={domain} data-unreachable={unreachable || undefined}>
      <div className="my-1 h-px w-8 bg-line" />
      <span className={`max-w-[64px] truncate text-[10px] leading-tight ${unreachable ? "text-danger" : "text-fg-2"}`} title={unreachable ? t("node.offline", { domain }) : domain}>
        {unreachable && <span role="img" aria-label={t("node.offline_short")}>⚠ </span>}
        {domain}
      </span>
      {rooms.map((r) => (
        <RailRoom key={r.key} entry={r} title={`${r.room.name} · ${domain}`} label={`${r.room.name} (${domain})`} dimmed={unreachable} shift={null} between={false} />
      ))}
    </div>
  );
}

const ROOM_PATH = /^\/(?:n\/([^/]+)\/)?rooms\/([^/]+)/;
/** Stands for the home node in the list of nodes whose room details the folders need. */
const HOME = "@home";

/** The rail element whose `data-*` attribute (camel-cased dataset name) has this value (no selector escaping). */
function railElement(root: ParentNode, name: "railKey" | "folderButton", value: string): HTMLElement | undefined {
  const attr = name === "railKey" ? "data-rail-key" : "data-folder-button";
  return [...root.querySelectorAll<HTMLElement>(`[${attr}]`)].find((el) => el.dataset[name] === value);
}

export function RoomRail() {
  const t = useT();
  const queryClient = useQueryClient();
  const rooms = useQuery({ queryKey: ["rooms"], queryFn: () => api.rooms.list() });
  const { closeNav } = useShell();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<FolderDialogState | null>(null);
  const navigate = useNavigate();
  const conversationIds = (useConversations().data ?? []).map((c) => c.id);
  const unread = useUnread((s) => conversationIds.some((id) => (s.states[id]?.unread ?? 0) > 0));
  const location = useLocation();
  const home = location.pathname === "/" || location.pathname.startsWith("/conversations") || /^\/n\/[^/]+\/conversations\//.test(location.pathname) || location.pathname === "/friends";
  const homeDomain = useAuth((s) => s.user?.domain) ?? "";
  const address = useAuth((s) => s.user?.address);
  const index = useConversationIndex((s) => s.state);
  const sessions = useNodes((s) => s.sessions);
  const rail = useRailFolders((s) => s.rail);
  const update = useRailFolders((s) => s.update);

  // The folders of this account (before anything below changes them).
  useEffect(() => {
    if (address) useRailFolders.getState().load(address);
  }, [address]);

  // Other nodes: those with a session and those the index names (rooms kept while a node is down).
  const indexed = new Map<string, string[]>();
  for (const d of Object.keys(sessions)) indexed.set(d, []);
  for (const e of index?.items ?? []) {
    if (e.node === homeDomain || e.kind !== "room" || !e.room_id) continue;
    indexed.set(e.node, [...(indexed.get(e.node) ?? []), e.room_id]);
  }
  indexed.delete(homeDomain);
  const domains = [...indexed.keys()].sort((a, b) => a.localeCompare(b));
  const remote = useQueries({ queries: domains.map((d) => ({ queryKey: ["rooms", d], queryFn: () => apiFor(d).rooms.list(), enabled: !!sessions[d], retry: 1 })) });

  const all = new Map<string, Resolved>();
  const homeKeys: string[] = [];
  for (const r of rooms.data ?? []) {
    const key = roomKey(homeDomain, r.id);
    homeKeys.push(key);
    all.set(key, { key, room: r, node: null });
  }
  const groups = domains.map((d, i) => {
    const list: RailRoomData[] = remote[i]?.data ?? (indexed.get(d) ?? []).map((id) => ({ id, name: "?" }));
    return { domain: d, rooms: list.map((r) => ({ key: roomKey(d, r.id), room: r, node: d })) };
  });
  for (const g of groups) for (const r of g.rooms) all.set(r.key, r);

  // Rooms a node no longer lists (left, deleted) leave the folders; only for lists that were loaded.
  const homeIds = rooms.data?.map((r) => r.id).join(",");
  useEffect(() => {
    if (!address || !homeDomain || homeIds === undefined) return;
    update((s) => pruneRooms(s, homeDomain, homeIds ? homeIds.split(",") : []));
  }, [address, homeDomain, homeIds, update]);
  const remoteIds = domains.map((d, i) => (remote[i]?.data ? `${d}=${remote[i]!.data!.map((r) => r.id).join(",")}` : "")).join(" ");
  useEffect(() => {
    if (!address) return;
    for (const part of remoteIds.split(" ").filter(Boolean)) {
      const [d, ids] = part.split("=") as [string, string];
      update((s) => pruneRooms(s, d, ids ? ids.split(",") : []));
    }
  }, [address, remoteIds, update]);

  // Folder badges need the room details (their channels); load them once for the nodes with rooms in folders.
  const folderNodes = [...new Set(rail.folders.flatMap((f) => f.roomIds.flatMap((k) => (all.has(k) ? [all.get(k)!.node ?? HOME] : []))))].sort().join(" ");
  useEffect(() => {
    for (const n of folderNodes ? folderNodes.split(" ") : []) void loadRoomDetails(queryClient, n === HOME ? null : n).catch(() => undefined);
  }, [folderNodes, queryClient]);

  const match = ROOM_PATH.exec(location.pathname);
  const activeKey = match ? roomKey(match[1] && !isHome(match[1]) ? decodeURIComponent(match[1]) : homeDomain, match[2]!) : null;

  const entries = topLevel(rail, homeKeys);
  const inFolder = new Set(rail.folders.flatMap((f) => f.roomIds));
  const loaded = rooms.data !== undefined;
  const homeKeysJoined = homeKeys.join(" ");
  const change = useCallback(
    (fn: (s: RailState) => RailState, focus?: string) => {
      const keys = homeKeysJoined ? homeKeysJoined.split(" ") : [];
      // Until the room list is there, the order is kept as stored (materializing would drop its rooms).
      update((s) => fn(loaded ? materialize(s, keys) : s));
      if (focus) requestAnimationFrame(() => railElement(document, "railKey", focus)?.focus());
    },
    [update, loaded, homeKeysJoined],
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const commit = useCallback(
    (target: string, mode: DropMode) => {
      const key = dragging;
      setDragging(null);
      setDrop(null);
      if (!key || key === target) return;
      if (mode === "end") change((s) => placeBefore(s, key, null));
      else if (mode === "before") change((s) => placeBefore(s, key, target));
      else if (mode === "after") change((s) => placeAfter(s, key, target));
      else if (isFolderEntry(target)) change((s) => moveToFolder(s, key, folderIdOf(target)));
      else change((s) => combineRooms(s, key, target, useRailFolders.getState().newId()));
    },
    [dragging, change],
  );
  const folderList = rail.folders.map((f) => ({ id: f.id, label: folderDisplayName(t, f, f.roomIds.flatMap((k) => all.get(k) ?? [])) }));
  const folderLabels = folderList.map((f) => `${f.id}=${f.label}`).join("\n");
  const [canDrag] = useState(() => !coarsePointer());
  const ctx = useMemo<RailContextValue>(
    () => ({ change, folders: folderList, activeKey, openDialog: setDialog, dragging, drop, canDrag, setDragging, setDrop, commit }),
    // folderList is rebuilt every render; its content is in folderLabels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [change, folderLabels, activeKey, dragging, drop, canDrag, commit],
  );

  // The rail's own menu (right-click or long press on its empty area, the context-menu key on Home, + or Discover).
  const railMenuTrigger = useContextMenu();
  const railMenuEntries = railMenuTrigger.open ? railMenu({ newFolder: () => setDialog({ mode: "new" }) }, t) : [];
  const railTrigger = {
    ...railMenuTrigger.triggerProps,
    onTouchStart: (e: TouchEvent) => {
      // Rooms and folders have their own menus.
      if ((e.target as Element).closest?.("[data-rail-item]")) return;
      railMenuTrigger.triggerProps.onTouchStart(e);
    },
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || fromPortal(e)) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-rail-nav]");
    if (!el) return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-rail-nav]")];
    const i = items.indexOf(el);
    const focus = (target: HTMLElement | undefined) => {
      if (!target) return;
      e.preventDefault();
      target.focus();
    };
    const folderId = el.dataset.folderButton;
    switch (e.key) {
      case "ArrowDown":
        focus(items[i + 1]);
        break;
      case "ArrowUp":
        focus(items[i - 1]);
        break;
      case "Home":
        focus(items[0]);
        break;
      case "End":
        focus(items[items.length - 1]);
        break;
      case "ArrowRight":
        if (folderId && el.getAttribute("aria-expanded") === "false") {
          e.preventDefault();
          change((s) => toggleExpanded(s, folderId, true), folderEntry(folderId));
        } else if (folderId) focus(items[i + 1]);
        break;
      case "ArrowLeft":
        if (folderId && el.getAttribute("aria-expanded") === "true") {
          e.preventDefault();
          change((s) => toggleExpanded(s, folderId, false), folderEntry(folderId));
        } else if (el.dataset.inFolder) focus(railElement(e.currentTarget, "folderButton", el.dataset.inFolder));
        break;
    }
  };

  const railDragOver = (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drop?.mode !== "end") setDrop({ target: "", mode: "end" });
  };

  return (
    <RailContext.Provider value={ctx}>
      <div
        className="flex w-full flex-1 flex-col items-center gap-2"
        data-testid="room-rail"
        onKeyDown={onKeyDown}
        onDragOver={railDragOver}
        onDrop={(e) => {
          if (!dragging) return;
          e.preventDefault();
          commit("", "end");
        }}
        {...railTrigger}
      >
        <NavLink to="/" data-rail-nav="" aria-label={t("shell.home")} title={t("shell.home")} className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${home ? "bg-bg-3 ring-2 ring-accent" : "bg-bg-3 hover:rounded-xl"}`}>
          <BrandIcon size={32} />
          {unread && <span role="img" className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-bg-0 bg-accent" aria-label={t("dm.unread")} data-testid="home-unread" />}
        </NavLink>
        <div className="my-1 h-px w-8 bg-line" />
        <ul aria-label={t("rail.list")} className="flex w-full flex-col items-center gap-2" data-testid="rail-list">
          {entries.map((e, i) => {
            const shift = { up: i > 0, down: i < entries.length - 1 };
            if (isFolderEntry(e)) {
              const folder = rail.folders.find((f) => f.id === folderIdOf(e))!;
              return <RailFolderItem key={e} folder={folder} rooms={folder.roomIds.flatMap((k) => all.get(k) ?? [])} expanded={rail.expanded.includes(folder.id)} shift={shift} />;
            }
            const r = all.get(e)!;
            return (
              <li key={e} className="relative">
                <RailRoom entry={r} title={r.room.name} label={r.room.name} shift={shift} between />
              </li>
            );
          })}
        </ul>
        {groups.map((g) => (
          <NodeRoomGroup key={g.domain} domain={g.domain} rooms={g.rooms.filter((r) => !inFolder.has(r.key))} />
        ))}
        <button type="button" data-rail-nav="" aria-label={t("shell.create_room")} title={t("shell.create_room")} onClick={() => setOpen(true)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-bg-3 text-xl text-accent hover:rounded-xl hover:bg-accent-soft">
          +
        </button>
        {/* Discover (FEDERATION.md §7.5): rooms and nodes of the directory. */}
        <NavLink to="/discover" onClick={closeNav} data-rail-nav="" aria-label={t("discover.title")} title={t("discover.title")} data-testid="nav-discover" className={({ isActive }) => `flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-bg-3 text-xl text-accent hover:rounded-xl hover:bg-accent-soft ${isActive ? "rounded-xl ring-2 ring-accent" : ""}`}>
          <span aria-hidden="true">🧭</span>
        </NavLink>
        {/* The empty rest of the rail: a drop here moves to the end of the top level (out of a folder). */}
        <div className="relative min-h-8 w-full flex-1" data-testid="rail-end">
          {drop?.mode === "end" && <DropLine at="before" />}
        </div>
      </div>
      {railMenuTrigger.open && railMenuTrigger.anchor && <ContextMenu entries={railMenuEntries} anchor={railMenuTrigger.anchor} onClose={railMenuTrigger.close} label={t("rail.menu")} testId="rail-menu" />}
      {dialog && (
        <FolderDialog
          state={dialog}
          onClose={() => setDialog(null)}
          onSubmit={(name, color) => {
            const d = dialog;
            setDialog(null);
            if (d.mode === "rename") {
              change((s) => setFolderColor(renameFolder(s, d.folder.id, name), d.folder.id, color), folderEntry(d.folder.id));
              return;
            }
            const id = useRailFolders.getState().newId();
            change((s) => createFolder(s, { id, name, color, roomKeys: d.roomKey ? [d.roomKey] : [] }), folderEntry(id));
          }}
        />
      )}
      <CreateRoomDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(path) => {
          setOpen(false);
          closeNav();
          navigate(path);
        }}
      />
    </RailContext.Provider>
  );
}

