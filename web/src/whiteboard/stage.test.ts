// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVoice, IDLE } from "../voice/store";

const boards: Array<{ close: ReturnType<typeof vi.fn> }> = [];
const stopScreenShare = vi.fn(async () => useVoice.setState({ screen: false }));
const opened = vi.fn(async () => undefined);
vi.mock("./store", () => ({ ownedBoards: () => boards, loadDraft: async () => null }));
vi.mock("../voice/index", () => ({ stopScreenShare: () => stopScreenShare() }));

const { beforeBoard, beforeScreenShare, boardIsWide, boardTileState, openBoard, presentationConflict, presenterIdentity, rowBoardAction, useBoardPreview } = await import("./stage");

beforeEach(() => {
  boards.length = 0;
  stopScreenShare.mockClear();
  opened.mockClear();
  useVoice.setState(IDLE);
});

describe("one presentation at a time", () => {
  it("names what has to stop first", () => {
    expect(presentationConflict("screen", { screen: false, board: false })).toBeNull();
    expect(presentationConflict("screen", { screen: false, board: true })).toBe("board");
    expect(presentationConflict("board", { screen: true, board: false })).toBe("screen");
    expect(presentationConflict("board", { screen: false, board: true })).toBeNull();
  });

  it("closes the own board before a screen share, only after confirmation", async () => {
    expect(await beforeScreenShare(() => false)).toBe(true); // nothing in the way: no question
    const close = vi.fn(async () => undefined);
    boards.push({ close });
    expect(await beforeScreenShare(() => false)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    const ask = vi.fn(() => true);
    expect(await beforeScreenShare(ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("Whiteboard"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops a screen share before a board, only after confirmation", async () => {
    expect(await beforeBoard(() => false)).toBe(true);
    useVoice.setState({ screen: true });
    expect(await beforeBoard(() => false)).toBe(false);
    expect(stopScreenShare).not.toHaveBeenCalled();
    expect(await beforeBoard(() => true)).toBe(true);
    expect(stopScreenShare).toHaveBeenCalledTimes(1);
    // Opening a board goes through the same check (no screen share any more: opens right away).
    const c = { open: opened };
    expect(await openBoard(c as never, { domain: "n.test", conversationId: "C" })).toBe(true);
    expect(opened).toHaveBeenCalledWith(undefined);
  });
});

describe("the board on the stage tiles", () => {
  const session = { owner: "alice@n.test", device_id: "DA" };
  it("finds the presenting tile: the owner's device, else any device of the owner", () => {
    expect(presenterIdentity(session, ["bob@n.test/DB", "alice@n.test/DA"])).toBe("alice@n.test/DA");
    expect(presenterIdentity(session, ["bob@n.test/DB", "alice@n.test/OTHER"])).toBe("alice@n.test/OTHER");
    expect(presenterIdentity(session, ["bob@n.test/DB"])).toBeNull();
    expect(presenterIdentity(null, ["alice@n.test/DA"])).toBeNull();
  });

  it("is its own stage tile: a placeholder until joined, the board once joined; the owner's preview can be hidden", () => {
    const view = (v: Partial<{ session: boolean; isOwner: boolean; joined: boolean; preview: boolean }>) => boardTileState({ session: true, isOwner: false, joined: false, preview: true, ...v });
    expect(view({ session: false })).toBe("none");
    expect(view({ session: false, isOwner: true })).toBe("none");
    // Others: "Join whiteboard" until they join, the board while joined, the placeholder again after leaving.
    expect(view({})).toBe("available");
    expect(view({ joined: true })).toBe("joined");
    // The preview flag is the owner's only.
    expect(view({ preview: false })).toBe("available");
    // The device that presents: the board as a preview it can hide (and show again).
    expect(view({ isOwner: true, joined: true })).toBe("preview");
    expect(view({ isOwner: true, joined: true, preview: false })).toBe("hidden");
  });

  it("knows whether the board is wider than tall (the phone's landscape lock in fullscreen)", () => {
    const el = (x: number, y: number, width: number, height: number, isDeleted = false) => ({ x, y, width, height, isDeleted });
    // An empty board is shown in a 16:9 tile: wide.
    expect(boardIsWide([])).toBe(true);
    expect(boardIsWide([el(0, 0, 400, 100)])).toBe(true);
    expect(boardIsWide([el(0, 0, 100, 400)])).toBe(false);
    // The bounding box of all elements counts, deleted ones not; negative sizes (drawn up or left) as well.
    expect(boardIsWide([el(0, 0, 100, 100), el(0, 500, 100, 100)])).toBe(false);
    expect(boardIsWide([el(0, 0, 100, 100), el(0, 500, 100, 100, true)])).toBe(true);
    expect(boardIsWide([el(500, 0, -500, 100)])).toBe(true);
  });

  it("the member list joins the board from inside the channel; the owner's own row shows the preview; elsewhere a hint", () => {
    const channel = { domain: "n.test", channelId: "C" };
    const here = { status: "connected" as const, target: { domain: "n.test", roomId: "R", channelId: "C" }, identity: "bob@n.test/DB" };
    expect(rowBoardAction({ identity: "alice@n.test/DA", presenting: true }, here, channel)).toBe("join");
    expect(rowBoardAction({ identity: "bob@n.test/DB", presenting: true }, here, channel)).toBe("preview");
    expect(rowBoardAction({ identity: "carol@n.test/DC", presenting: false }, here, channel)).toBeNull();
    expect(rowBoardAction({ identity: "alice@n.test/DA", presenting: true }, { ...here, target: { ...here.target, channelId: "OTHER" } }, channel)).toBe("hint");
    expect(rowBoardAction({ identity: "alice@n.test/DA", presenting: true }, { status: "idle", target: null, identity: null }, channel)).toBe("hint");
  });

  it("opening a board shows the owner's preview again", async () => {
    useBoardPreview.setState({ shown: false });
    expect(await openBoard({ open: opened } as never, { domain: "n.test", conversationId: "C" })).toBe(true);
    expect(useBoardPreview.getState().shown).toBe(true);
  });
});
