// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// The whiteboard on the voice stage as its own tile, like a screen share (docs/CLIENT.md "Streams are joined"):
// a placeholder with "Join whiteboard" until joined, the board in a large tile once joined, "Leave whiteboard"
// back to the placeholder; the owner gets a preview that can be hidden and the "Whiteboard is open" bar.

const board = vi.hoisted(() => ({
  session: null as null | { owner: string; device_id: string },
  isOwner: false,
  joined: false,
  thumbnailUrl: null as string | null,
  join: vi.fn(),
  leave: vi.fn(),
  controller: { participants: new Map<string, unknown>(), elements: new Map<string, unknown>(), close: vi.fn(async () => undefined) },
}));
vi.mock("./store", () => ({ useWhiteboardSession: () => board, useBoardContent: () => 0, ownedBoards: () => [], loadDraft: async () => null }));
vi.mock("../components/NodeScope", () => ({ useNode: () => ({ domain: "n.test" }) }));
vi.mock("../voice/index", () => ({ stopScreenShare: vi.fn(async () => undefined), toggleMute: vi.fn(), toggleDeafen: vi.fn(), leaveVoice: vi.fn() }));
// The board itself (Excalidraw) is not part of these tests: the lazy tile renders its header extras only.
vi.mock("./WhiteboardStageTile", () => ({ default: ({ headerExtra }: { headerExtra?: ReactNode }) => <div data-testid="whiteboard-stage-tile">{headerExtra}</div> }));

const { WhiteboardPlaceholder, WhiteboardLargeTile, WhiteboardIndicator } = await import("./WhiteboardStage");
const { useBoardPreview } = await import("./stage");

beforeEach(() => {
  board.session = { owner: "alice@n.test", device_id: "DA" };
  board.isOwner = false;
  board.joined = false;
  board.thumbnailUrl = null;
  board.join.mockClear();
  board.leave.mockClear();
  board.controller.close.mockClear();
  board.controller.participants.clear();
  board.controller.elements.clear();
  useBoardPreview.setState({ shown: true });
});

afterEach(() => vi.restoreAllMocks());

describe("the whiteboard tile", () => {
  it("before joining: the badge, who started it, the live thumbnail and one button to join", () => {
    board.thumbnailUrl = "data:image/webp;base64,AAAA";
    render(<WhiteboardPlaceholder channelId="C" name="Alice" />);
    const tile = screen.getByTestId("whiteboard-tile");
    expect(tile).toHaveAttribute("data-state", "available");
    expect(within(tile).getByTestId("whiteboard-tile-title")).toHaveTextContent("Whiteboard · Alice");
    expect(within(tile).getByTestId("whiteboard-badge")).toBeInTheDocument();
    expect(within(tile).getByTestId("whiteboard-thumbnail")).toHaveAttribute("src", board.thumbnailUrl);
    expect(tile.querySelector("[data-testid=whiteboard-stage-tile]")).toBeNull();
    const join = within(tile).getByRole("button", { name: "Whiteboard beitreten (Alice)" });
    expect(join).toHaveTextContent("Whiteboard beitreten");
    fireEvent.click(join);
    expect(board.join).toHaveBeenCalledTimes(1);
  });

  it("a double-click on the placeholder joins as well", () => {
    render(<WhiteboardPlaceholder channelId="C" name="Alice" />);
    fireEvent.doubleClick(screen.getByTestId("whiteboard-tile"));
    expect(board.join).toHaveBeenCalledTimes(1);
  });

  it("joined: the board in a large tile with Leave whiteboard, which goes back to the placeholder", async () => {
    board.joined = true;
    render(<WhiteboardLargeTile roomId="R" channelId="C" name="Alice" focused={false} onFocus={() => undefined} />);
    const tile = screen.getByTestId("whiteboard-tile");
    expect(tile).toHaveAttribute("data-state", "joined");
    expect(tile).toHaveAttribute("data-wide", "true");
    expect(await within(tile).findByTestId("whiteboard-stage-tile")).toBeInTheDocument();
    expect(within(tile).getByTestId("whiteboard-fullscreen")).toBeInTheDocument();
    expect(within(tile).queryByTestId("whiteboard-preview-hide")).toBeNull();
    fireEvent.click(within(tile).getByRole("button", { name: "Whiteboard verlassen (Alice)" }));
    expect(board.leave).toHaveBeenCalledTimes(1);
  });

  it("a tall board is no wide tile (no landscape lock in fullscreen)", async () => {
    board.joined = true;
    board.controller.elements.set("a", { x: 0, y: 0, width: 100, height: 900 });
    render(<WhiteboardLargeTile roomId="R" channelId="C" name="Alice" focused={false} onFocus={() => undefined} />);
    expect(screen.getByTestId("whiteboard-tile")).toHaveAttribute("data-wide", "false");
    await screen.findByTestId("whiteboard-stage-tile");
  });

  it("the owner's tile is a preview that can be hidden (it never leaves the own board)", async () => {
    board.isOwner = true;
    board.joined = true;
    render(<WhiteboardLargeTile roomId="R" channelId="C" name="Alice" focused={false} onFocus={() => undefined} />);
    const tile = screen.getByTestId("whiteboard-tile");
    expect(tile).toHaveAttribute("data-state", "preview");
    await within(tile).findByTestId("whiteboard-stage-tile");
    expect(within(tile).queryByRole("button", { name: /Whiteboard verlassen/ })).toBeNull();
    fireEvent.click(within(tile).getByTestId("whiteboard-preview-hide"));
    expect(useBoardPreview.getState().shown).toBe(false);
    expect(board.leave).not.toHaveBeenCalled();
  });
});

describe("the Whiteboard is open bar", () => {
  it("only on the device that presents", () => {
    const { container } = render(<WhiteboardIndicator channelId="C" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows how many joined, toggles the preview and closes the board after asking", () => {
    board.isOwner = true;
    board.joined = true;
    board.controller.participants.set("bob@n.test/DB", {});
    render(<WhiteboardIndicator channelId="C" />);
    const bar = screen.getByTestId("whiteboard-indicator");
    expect(bar).toHaveTextContent("Whiteboard ist geöffnet");
    expect(within(bar).getByTestId("whiteboard-joined-count")).toHaveTextContent("1 beigetreten");
    const toggle = within(bar).getByTestId("whiteboard-preview-toggle");
    expect(toggle).toHaveTextContent("Vorschau ausblenden");
    act(() => fireEvent.click(toggle));
    expect(useBoardPreview.getState().shown).toBe(false);
    expect(toggle).toHaveTextContent("Vorschau zeigen");
    act(() => fireEvent.click(toggle));
    expect(useBoardPreview.getState().shown).toBe(true);
    // Close asks first; a no keeps the board.
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(within(bar).getByTestId("whiteboard-stop"));
    expect(board.controller.close).not.toHaveBeenCalled();
    fireEvent.click(within(bar).getByTestId("whiteboard-stop"));
    expect(ask).toHaveBeenCalledWith("Das Whiteboard für alle schließen?");
    expect(board.controller.close).toHaveBeenCalledTimes(1);
  });
});
