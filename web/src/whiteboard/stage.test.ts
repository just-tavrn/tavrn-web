// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVoice, IDLE } from "../voice/store";

const boards: Array<{ close: ReturnType<typeof vi.fn> }> = [];
const stopScreenShare = vi.fn(async () => useVoice.setState({ screen: false }));
const opened = vi.fn(async () => undefined);
vi.mock("./store", () => ({ ownedBoards: () => boards, loadDraft: async () => null }));
vi.mock("../voice/index", () => ({ stopScreenShare: () => stopScreenShare() }));

const { beforeBoard, beforeScreenShare, openBoard, presentationConflict, presenterIdentity, tileBoardState } = await import("./stage");

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

  it("shows join on the presenter's tile for others, the count for the owner, and who watches", () => {
    const none = new Map<string, unknown>();
    const watchers = new Map<string, unknown>([["bob@n.test/DB", {}]]);
    const presenter = "alice@n.test/DA";
    // Bob before joining: badge, thumbnail and "Join whiteboard session".
    expect(tileBoardState({ identity: presenter, self: false }, presenter, { joined: false, isOwner: false, watchers: none })).toEqual({ kind: "presenting", self: false, canJoin: true, watching: 0 });
    // Bob joined: no join button any more.
    expect(tileBoardState({ identity: presenter, self: false }, presenter, { joined: true, isOwner: false, watchers: none })).toMatchObject({ canJoin: false });
    // Alice's own tile: who joined.
    expect(tileBoardState({ identity: presenter, self: true }, presenter, { joined: true, isOwner: true, watchers })).toEqual({ kind: "presenting", self: true, canJoin: false, watching: 1 });
    // Alice sees that Bob watches; Bob's tile looks normal to others.
    expect(tileBoardState({ identity: "bob@n.test/DB", self: false }, presenter, { joined: true, isOwner: true, watchers })).toEqual({ kind: "watching" });
    expect(tileBoardState({ identity: "bob@n.test/DB", self: false }, presenter, { joined: false, isOwner: false, watchers })).toEqual({ kind: "none" });
    expect(tileBoardState({ identity: presenter, self: false }, null, { joined: false, isOwner: false, watchers: none })).toEqual({ kind: "none" });
  });
});
