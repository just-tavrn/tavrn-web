// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { findEntry, staysOpen, type MenuEntry, type MenuItem, type MenuSubmenu } from "../components/ContextMenu";
import { railFolderMenu, railMenu, railRoomEntries } from "./railMenus";

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key}(${Object.values(params).join(",")})` : key);
const ids = (entries: MenuEntry[]) => entries.map((e) => e.id);
const noop = () => {};
const roomActions = { moveTo: vi.fn(), newFolder: vi.fn(), remove: vi.fn(), up: vi.fn(), down: vi.fn() };

describe("rail menus", () => {
  it("the empty rail offers a new folder", () => {
    const newFolder = vi.fn();
    const entries = railMenu({ newFolder }, t);
    expect(ids(entries)).toEqual(["new-folder"]);
    (entries[0] as MenuItem).onSelect!();
    expect(newFolder).toHaveBeenCalled();
  });

  it("a top-level room: move to one of the folders or a new one, move up and down", () => {
    const entries = railRoomEntries({ folders: [{ id: "F", label: "Games" }, { id: "G", label: "Work" }], current: null, shift: { up: true, down: false } }, roomActions, t);
    const sub = findEntry(entries, "move-to-folder") as MenuSubmenu;
    expect(ids(sub.items)).toEqual(["folder-F", "folder-G", "sep-new", "new-folder"]);
    (findEntry(entries, "folder-G") as MenuItem).onSelect!();
    expect(roomActions.moveTo).toHaveBeenCalledWith("G");
    expect(findEntry(entries, "remove-from-folder")).toBeUndefined();
    expect(findEntry(entries, "move-up")?.disabled).toBeFalsy();
    expect(findEntry(entries, "move-down")?.disabled).toBe(true);
  });

  it("a room in a folder: the other folders and remove from folder", () => {
    const entries = railRoomEntries({ folders: [{ id: "F", label: "Games" }, { id: "G", label: "Work" }], current: "F", shift: { up: false, down: true } }, roomActions, t);
    const sub = findEntry(entries, "move-to-folder") as MenuSubmenu;
    expect(ids(sub.items)).toEqual(["folder-G", "sep-new", "new-folder", "remove-from-folder"]);
  });

  it("without folders the submenu still offers a new folder; rooms of other nodes outside folders cannot be reordered", () => {
    const entries = railRoomEntries({ folders: [], current: null, shift: null }, roomActions, t);
    expect(ids((findEntry(entries, "move-to-folder") as MenuSubmenu).items)).toEqual(["new-folder"]);
    expect(findEntry(entries, "move-up")).toBeUndefined();
  });

  it("a folder: rename, colour (current one checked), expand or collapse, reorder, delete", () => {
    const a = { toggle: vi.fn(), rename: vi.fn(), setColor: vi.fn(), up: noop, down: noop, remove: vi.fn() };
    const entries = railFolderMenu({ expanded: false, color: "rose", shift: { up: false, down: true } }, a, t);
    expect(ids(entries)).toEqual(["rename", "color", "toggle", "sep-move", "move-up", "move-down", "sep-delete", "delete"]);
    expect(findEntry(entries, "toggle")?.label).toBe("rail.folder.expand");
    const colors = findEntry(entries, "color") as MenuSubmenu;
    expect(ids(colors.items)).toEqual(["color-none", "color-teal", "color-blue", "color-violet", "color-rose", "color-amber", "color-green"]);
    expect((findEntry(entries, "color-rose") as MenuItem).checked).toBe(true);
    expect((findEntry(entries, "color-none") as MenuItem).checked).toBe(false);
    // Choosing a colour keeps the menu open (the new colour is checked); rename, expand and delete close it.
    expect(staysOpen(findEntry(entries, "color-rose") as MenuItem)).toBe(true);
    expect(["rename", "toggle", "delete"].map((id) => staysOpen(findEntry(entries, id) as MenuItem))).toEqual([false, false, false]);
    (findEntry(entries, "color-none") as MenuItem).onSelect!();
    expect(a.setColor).toHaveBeenCalledWith(undefined);
    expect((findEntry(entries, "delete") as MenuItem).danger).toBe(true);
    expect(findEntry(railFolderMenu({ expanded: true, shift: { up: true, down: true } }, a, t), "toggle")?.label).toBe("rail.folder.collapse");
  });
});
