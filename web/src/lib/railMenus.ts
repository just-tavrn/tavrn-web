// SPDX-License-Identifier: Apache-2.0
/**
 * The menus of the room rail's folders (docs/CLIENT.md "Room rail and folders"): the empty rail ("New folder…"),
 * the folder entries added to a room's menu, and a folder's own menu. Every drag-and-drop action has an entry here
 * (WCAG 2.5.7): moving into and out of folders, combining, and reordering with "Move up" / "Move down".
 */
import { menuItem, normalizeMenu, separator, submenu, type MenuEntry } from "../components/ContextMenu";
import { FOLDER_COLORS, type FolderColor } from "../stores/railFolders";

type T = (key: string, params?: Record<string, string | number>) => string;

/** Whether the entry can move up or down among its neighbours; null: not reorderable (no entries). */
export type Shift = { up: boolean; down: boolean } | null;

const shiftEntries = (shift: Shift, a: { up: () => void; down: () => void }, t: T): Array<MenuEntry | false> =>
  shift
    ? [
        menuItem("move-up", t("rail.move_up"), a.up, { icon: "↑", disabled: !shift.up }),
        menuItem("move-down", t("rail.move_down"), a.down, { icon: "↓", disabled: !shift.down }),
      ]
    : [];

export function railMenu(a: { newFolder: () => void }, t: T): MenuEntry[] {
  return normalizeMenu([menuItem("new-folder", t("rail.new_folder"), a.newFolder, { icon: "📁" })]);
}

export interface RailRoomContext {
  folders: { id: string; label: string }[];
  /** The folder the room is in. */
  current: string | null;
  shift: Shift;
}

export interface RailRoomActions {
  moveTo: (folderId: string) => void;
  newFolder: () => void;
  remove: () => void;
  up: () => void;
  down: () => void;
}

/** Added to a room's menu in the rail. */
export function railRoomEntries(c: RailRoomContext, a: RailRoomActions, t: T): MenuEntry[] {
  return normalizeMenu([
    submenu(
      "move-to-folder",
      t("rail.move_to_folder"),
      [
        ...c.folders.filter((f) => f.id !== c.current).map((f) => menuItem(`folder-${f.id}`, f.label, () => a.moveTo(f.id), { icon: "📁" })),
        separator("sep-new"),
        menuItem("new-folder", t("rail.new_folder"), a.newFolder, { icon: "+" }),
        !!c.current && menuItem("remove-from-folder", t("rail.remove_from_folder"), a.remove, { icon: "↩" }),
      ],
      { icon: "📁" },
    ),
    ...shiftEntries(c.shift, a, t),
  ]);
}

export interface RailFolderContext {
  expanded: boolean;
  color?: FolderColor;
  shift: Shift;
}

export interface RailFolderActions {
  toggle: () => void;
  rename: () => void;
  setColor: (color: FolderColor | undefined) => void;
  up: () => void;
  down: () => void;
  remove: () => void;
}

export function railFolderMenu(c: RailFolderContext, a: RailFolderActions, t: T): MenuEntry[] {
  return normalizeMenu([
    menuItem("rename", t("rail.folder.rename"), a.rename, { icon: "✎" }),
    submenu(
      "color",
      t("rail.folder.color"),
      [menuItem("color-none", t("rail.color.none"), () => a.setColor(undefined), { checked: !c.color }), ...FOLDER_COLORS.map((color) => menuItem(`color-${color}`, t(`rail.color.${color}`), () => a.setColor(color), { checked: c.color === color }))],
      { icon: "🎨" },
    ),
    menuItem("toggle", t(c.expanded ? "rail.folder.collapse" : "rail.folder.expand"), a.toggle, { icon: c.expanded ? "▴" : "▾" }),
    separator("sep-move"),
    ...shiftEntries(c.shift, a, t),
    separator("sep-delete"),
    menuItem("delete", t("rail.folder.delete"), a.remove, { icon: "🗑", danger: true }),
  ]);
}
