// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_RAIL,
  FOLDER_NAME_MAX,
  RAIL_STATE_VERSION,
  aggregateCounts,
  combineRooms,
  createFolder,
  deleteFolder,
  folderEntry,
  folderOf,
  materialize,
  moveToFolder,
  parseRailState,
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
  type RailState,
} from "./railFolders";

const H = "home.example";
const R = "remote.example";
const a = roomKey(H, "A");
const b = roomKey(H, "B");
const c = roomKey(H, "C");
const d = roomKey(H, "D");
const x = roomKey(R, "X");
const home = [a, b, c, d];

/** A rail with one folder "F" (b, c) between a and d. */
function withFolder(): RailState {
  return createFolder(materialize(EMPTY_RAIL, home), { id: "F", name: "Games", roomKeys: [b, c] });
}

describe("rail folders: data shape", () => {
  it("room keys are node-qualified, folder entries are prefixed", () => {
    expect(roomKey("n.example:8800", "01X")).toBe("n.example:8800/01X");
    expect(folderEntry("F")).toBe("folder:F");
  });

  it("no stored state (first start, or before folders existed) is an empty rail of the current version", () => {
    expect(parseRailState(null)).toEqual(EMPTY_RAIL);
    expect(parseRailState(undefined)).toEqual(EMPTY_RAIL);
    expect(parseRailState("garbage")).toEqual(EMPTY_RAIL);
    expect(EMPTY_RAIL).toEqual({ clientStateVersion: RAIL_STATE_VERSION, folders: [], order: [], expanded: [] });
  });

  it("a newer version than this client knows is not interpreted", () => {
    expect(parseRailState({ clientStateVersion: RAIL_STATE_VERSION + 1, folders: [{ id: "F", name: "x", roomIds: [a] }], order: ["folder:F"], expanded: [] })).toEqual(EMPTY_RAIL);
  });

  it("parsing repairs what it can: bad fields, duplicates, missing order entries, unknown colours", () => {
    const parsed = parseRailState({
      clientStateVersion: RAIL_STATE_VERSION,
      folders: [
        { id: "F", name: "  Games  ", color: "rose", roomIds: [a, a, b, 7] },
        { id: "G", name: "x".repeat(200), color: "#ff0000", roomIds: [b, c] },
        { id: 3, name: "bad" },
        { id: "F", name: "dup id", roomIds: [d] },
      ],
      order: [a, "folder:missing", c, c, d],
      expanded: ["F", "nope"],
    });
    expect(parsed.folders).toEqual([
      { id: "F", name: "Games", color: "rose", roomIds: [a, b] },
      { id: "G", name: "x".repeat(FOLDER_NAME_MAX), roomIds: [c] },
    ]);
    // Rooms inside folders leave the top level; every folder gets a place.
    expect(parsed.order).toEqual([d, "folder:F", "folder:G"]);
    expect(parsed.expanded).toEqual(["F"]);
  });
});

describe("rail folders: layout", () => {
  it("without folders the rail keeps the node's room order", () => {
    expect(topLevel(EMPTY_RAIL, home)).toEqual(home);
  });

  it("the stored order wins, new rooms are appended, rooms in folders and unknown keys are hidden", () => {
    const s: RailState = { ...EMPTY_RAIL, folders: [{ id: "F", name: "", roomIds: [b] }], order: [d, "folder:F", "gone.example/Z", a] };
    expect(topLevel(s, home)).toEqual([d, "folder:F", a, c]);
  });

  it("rooms of other nodes are not top-level entries (they stay under their domain)", () => {
    const s = removeFromFolder(moveToFolder(withFolder(), x, "F"), x);
    expect(topLevel(s, home)).not.toContain(x);
    expect(folderOf(s, x)).toBeUndefined();
  });

  it("materialize writes the visible order (before the first move)", () => {
    expect(materialize(EMPTY_RAIL, home).order).toEqual(home);
  });
});

describe("rail folders: editing", () => {
  it("creates a folder at the place of its first room", () => {
    const s = withFolder();
    expect(s.folders).toEqual([{ id: "F", name: "Games", roomIds: [b, c] }]);
    expect(topLevel(s, home)).toEqual([a, "folder:F", d]);
  });

  it("creates an empty folder at the end, with a colour, a trimmed and capped name", () => {
    const s = createFolder(materialize(EMPTY_RAIL, home), { id: "E", name: `  ${"n".repeat(50)} `, color: "amber" });
    expect(s.folders[0]).toEqual({ id: "E", name: "n".repeat(FOLDER_NAME_MAX), color: "amber", roomIds: [] });
    expect(topLevel(s, home)).toEqual([...home, "folder:E"]);
  });

  it("renames and recolours; an unknown colour removes it", () => {
    let s = renameFolder(withFolder(), "F", " Raids ");
    s = setFolderColor(s, "F", "violet");
    expect(s.folders[0]).toMatchObject({ name: "Raids", color: "violet" });
    s = setFolderColor(s, "F", undefined);
    expect(s.folders[0]!.color).toBeUndefined();
    expect("color" in s.folders[0]!).toBe(false);
  });

  it("deleting a folder puts its rooms back at its place; nothing else changes", () => {
    const s = deleteFolder(toggleExpanded(withFolder(), "F", true), "F");
    expect(s.folders).toEqual([]);
    expect(s.expanded).toEqual([]);
    expect(topLevel(s, home)).toEqual([a, b, c, d]);
  });

  it("moves a room into a folder (at an index) and out again (after the folder)", () => {
    let s = moveToFolder(withFolder(), a, "F", 1);
    expect(s.folders[0]!.roomIds).toEqual([b, a, c]);
    expect(topLevel(s, home)).toEqual(["folder:F", d]);
    s = removeFromFolder(s, b);
    expect(s.folders[0]!.roomIds).toEqual([a, c]);
    expect(topLevel(s, home)).toEqual(["folder:F", b, d]);
  });

  it("moving a room from one folder into another", () => {
    let s = createFolder(withFolder(), { id: "G", name: "Work", roomKeys: [d] });
    s = moveToFolder(s, b, "G");
    expect(folderOf(s, b)?.id).toBe("G");
    expect(s.folders.find((f) => f.id === "F")!.roomIds).toEqual([c]);
  });

  it("a folder emptied by moving its last room out disappears", () => {
    let s = removeFromFolder(withFolder(), b);
    s = removeFromFolder(s, c);
    expect(s.folders).toEqual([]);
    // Each one lands right after the folder, and the empty folder's place goes to the last one.
    expect(topLevel(s, home)).toEqual([a, c, b, d]);
    expect(s.order).not.toContain("folder:F");
  });

  it("reorders top-level entries: before an entry or at the end", () => {
    let s = placeBefore(withFolder(), d, a);
    expect(topLevel(s, home)).toEqual([d, a, "folder:F"]);
    s = placeBefore(s, folderEntry("F"), null);
    expect(topLevel(s, home)).toEqual([d, a, "folder:F"]);
    s = placeBefore(s, folderEntry("F"), d);
    expect(topLevel(s, home)).toEqual(["folder:F", d, a]);
  });

  it("placing a room of a folder between top-level entries takes it out of the folder", () => {
    const s = placeBefore(withFolder(), c, a);
    expect(topLevel(s, home)).toEqual([c, a, "folder:F", d]);
    expect(s.folders[0]!.roomIds).toEqual([b]);
  });

  it("placing a room before a room inside a folder moves it into that folder there", () => {
    const s = placeBefore(withFolder(), d, c);
    expect(s.folders[0]!.roomIds).toEqual([b, d, c]);
  });

  it("moves an entry up and down (the menu alternative to dragging), inside a folder too", () => {
    let s = shiftEntry(withFolder(), d, -1);
    expect(topLevel(s, home)).toEqual([a, d, "folder:F"]);
    s = shiftEntry(s, a, -1);
    expect(topLevel(s, home)).toEqual([a, d, "folder:F"]);
    s = shiftEntry(s, c, -1);
    expect(s.folders[0]!.roomIds).toEqual([c, b]);
    s = shiftEntry(s, c, 5);
    expect(s.folders[0]!.roomIds).toEqual([b, c]);
  });

  it("dropping a room onto another room makes a folder of both at the target's place", () => {
    const s = combineRooms(materialize(EMPTY_RAIL, home), d, b, "N");
    expect(s.folders).toEqual([{ id: "N", name: "", roomIds: [b, d] }]);
    expect(topLevel(s, home)).toEqual([a, "folder:N", c]);
  });

  it("dropping onto a room inside a folder adds to that folder", () => {
    const s = combineRooms(withFolder(), a, c, "N");
    expect(s.folders).toHaveLength(1);
    expect(s.folders[0]!.roomIds).toEqual([b, c, a]);
  });

  it("rooms of several nodes can share a folder", () => {
    const s = combineRooms(materialize(EMPTY_RAIL, home), x, a, "N");
    expect(s.folders[0]!.roomIds).toEqual([a, x]);
  });

  it("expands and collapses", () => {
    let s = toggleExpanded(withFolder(), "F");
    expect(s.expanded).toEqual(["F"]);
    s = toggleExpanded(s, "F");
    expect(s.expanded).toEqual([]);
    s = toggleExpanded(s, "F", false);
    expect(s.expanded).toEqual([]);
  });

  it("unknown folder ids change nothing", () => {
    const s = withFolder();
    expect(renameFolder(s, "nope", "x")).toBe(s);
    expect(moveToFolder(s, a, "nope")).toBe(s);
    expect(deleteFolder(s, "nope")).toBe(s);
  });
});

describe("rail folders: pruning", () => {
  it("rooms a node no longer lists leave folders and the order; other nodes are untouched", () => {
    let s = moveToFolder(withFolder(), x, "F");
    s = pruneRooms(s, H, ["A", "C"]);
    expect(s.folders[0]!.roomIds).toEqual([c, x]);
    expect(s.order).toEqual([a, "folder:F"]);
    s = pruneRooms(s, R, []);
    expect(s.folders[0]!.roomIds).toEqual([c]);
  });

  it("returns the same state when nothing is pruned (no needless saves)", () => {
    const s = withFolder();
    expect(pruneRooms(s, H, ["A", "B", "C", "D"])).toBe(s);
  });

  it("keeps a folder whose rooms were all left (the user deletes it)", () => {
    const s = pruneRooms(withFolder(), H, ["A", "D"]);
    expect(s.folders).toEqual([{ id: "F", name: "Games", roomIds: [] }]);
  });
});

describe("rail folders: badges", () => {
  const states = {
    c1: { last: "2", read: "1", unread: 3, mentions: 0 },
    c2: { last: "2", read: "1", unread: 2, mentions: 1 },
    c3: { last: "2", read: "1", unread: 998, mentions: 998 },
  };

  it("a room sums its channels", () => {
    expect(roomCounts(states, ["c1", "c2", "unknown"])).toEqual({ unread: 5, mentions: 1 });
    expect(roomCounts(states, [])).toEqual({ unread: 0, mentions: 0 });
  });

  it("a folder sums its rooms, capped like every counter", () => {
    expect(aggregateCounts([{ unread: 5, mentions: 1 }, { unread: 0, mentions: 0 }])).toEqual({ unread: 5, mentions: 1 });
    expect(aggregateCounts([roomCounts(states, ["c3"]), roomCounts(states, ["c2"])])).toEqual({ unread: 999, mentions: 999 });
  });
});

describe("rail folders: store", () => {
  beforeEach(() => {
    localStorage.clear();
    useRailFolders.getState().reset();
  });

  it("is kept per account on this device", () => {
    useRailFolders.getState().load("alice@home.example");
    useRailFolders.getState().update((s) => createFolder(s, { id: "F", name: "Games", roomKeys: [a] }));
    expect(JSON.parse(localStorage.getItem("tavrn.rail:alice@home.example")!)).toMatchObject({ clientStateVersion: RAIL_STATE_VERSION, folders: [{ id: "F", name: "Games" }] });
    useRailFolders.getState().load("bob@home.example");
    expect(useRailFolders.getState().rail).toEqual(EMPTY_RAIL);
    useRailFolders.getState().load("alice@home.example");
    expect(useRailFolders.getState().rail.folders[0]!.name).toBe("Games");
  });

  it("unchanged updates do not write", () => {
    useRailFolders.getState().load("alice@home.example");
    useRailFolders.getState().update((s) => s);
    expect(localStorage.getItem("tavrn.rail:alice@home.example")).toBeNull();
  });

  it("new folder ids are unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => useRailFolders.getState().newId()));
    expect(ids.size).toBe(50);
  });
});
