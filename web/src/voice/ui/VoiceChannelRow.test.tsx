// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceParticipant } from "@tavrn/sdk";

// The voice channel's member list in the sidebar: the whiteboard badge next to LIVE, and joining the board with a
// double-click or Enter on its owner (docs/CLIENT.md "Streams are joined", the whiteboard follows that model).

const board = vi.hoisted(() => ({
  session: null as null | { owner: string; device_id: string },
  isOwner: false,
  joined: false,
  join: vi.fn(),
}));
vi.mock("../../whiteboard/store", () => ({ useWhiteboardSession: () => ({ ...board, leave: vi.fn(), thumbnailUrl: null, controller: { participants: new Map() } }) }));
vi.mock("../../components/NodeScope", () => ({ useNode: () => ({ api: {}, domain: "n.test", me: { id: "u-bob" }, roomPath: (r: string, c?: string) => `/rooms/${r}/channels/${c}` }) }));
vi.mock("../../pages/ChannelPage", () => ({ channelPermissions: () => (1n << 63n) - 1n, useRoomMembers: () => ({ data: [] }) }));
vi.mock("../useVoiceRealtime", () => ({ useRoomVoiceStates: () => undefined }));
vi.mock("../index", () => ({ joinStream: vi.fn(), joinVoice: vi.fn(async () => undefined) }));
vi.mock("../../components/menus/ChannelMenu", () => ({ useChannelMenu: () => ({ menu: { triggerProps: {} }, overlay: null }) }));
vi.mock("./useParticipantMenu", () => ({ useParticipantMenu: () => ({ menu: { triggerProps: {} }, overlay: null }) }));
vi.mock("../../components/ContextMenu", () => ({ MenuButton: () => null }));
vi.mock("./AvatarTile", () => ({ AvatarTile: () => null }));
vi.mock("../../lib/channelPermissions", () => ({ channelAccessMarks: () => [] }));

const { VoiceChannelRow } = await import("./VoiceChannelRow");
const { joinStream } = await import("../index");
const { useVoicePresence } = await import("../presence");
const { useVoice, IDLE } = await import("../store");
const { useToasts } = await import("../../stores/toasts");
const { useBoardPreview } = await import("../../whiteboard/stage");
const { useLocalMute, setLocalMute } = await import("../localMute");
const { useSpeaking } = await import("../store");

const participant = (user: string, device: string, extra: Partial<VoiceParticipant> = {}) =>
  ({ identity: `${user}/${device}`, user, user_id: `u-${user.split("@")[0]}`, device_id: device, muted: false, deafened: false, server_muted: false, streaming: false, camera: false, ...extra }) as VoiceParticipant;

const room = { id: "R", roles: [], channels: [] } as never;
const channel = { id: "C", kind: "voice", name: "Sprache" } as never;

function Where() {
  return <p data-testid="path">{useLocation().pathname}</p>;
}

function renderRow() {
  return render(
    <MemoryRouter initialEntries={["/rooms/R/channels/T"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <VoiceChannelRow room={room} channel={channel} onNavigate={() => undefined} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const row = (address: string) => screen.getAllByTestId("voice-participant").find((el) => el.getAttribute("data-user") === address)!;
const inChannel = (identity: string, channelId = "C") => useVoice.setState({ ...IDLE, status: "connected", identity, target: { domain: "n.test", roomId: "R", channelId } });

beforeEach(() => {
  board.session = { owner: "alice@n.test", device_id: "DA" };
  board.isOwner = false;
  board.joined = false;
  board.join.mockClear();
  vi.mocked(joinStream).mockClear();
  useToasts.setState({ toasts: [] });
  useBoardPreview.setState({ shown: true });
  useVoicePresence.getState().apply("n.test", { room_id: "R", channel_id: "C", participants: [participant("alice@n.test", "DA"), participant("bob@n.test", "DB"), participant("carol@n.test", "DC", { streaming: true })], epoch: null } as never);
});

afterEach(() => {
  useVoice.setState(IDLE);
  useVoicePresence.setState({ channels: {}, epochs: {}, rooms: {} });
  useLocalMute.setState({ muted: {} });
  useSpeaking.setState({ levels: {} });
});

describe("muted for you (issue #124)", () => {
  it("marks a locally muted participant, never shows them speaking, and the marker unmutes with one click", () => {
    inChannel("bob@n.test/DB");
    renderRow();
    expect(screen.queryByTestId("local-mute-mark")).toBeNull();
    act(() => setLocalMute("alice@n.test", true));
    act(() => useSpeaking.setState({ levels: { "alice@n.test/DA": 0.8, "carol@n.test/DC": 0.5 } }));
    const alice = row("alice@n.test");
    expect(alice).toHaveAttribute("data-local-muted", "true");
    expect(alice).not.toHaveAttribute("data-speaking");
    expect(row("carol@n.test")).toHaveAttribute("data-speaking", "true");
    const mark = within(alice).getByTestId("local-mute-mark");
    expect(mark).toHaveAccessibleName("alice für dich wieder laut schalten");
    expect(mark.getAttribute("title")).toContain("Für dich stumm");
    fireEvent.click(mark);
    expect(useLocalMute.getState().muted).toEqual({});
    expect(within(row("alice@n.test")).queryByTestId("local-mute-mark")).toBeNull();
    expect(row("alice@n.test")).toHaveAttribute("data-speaking", "true");
  });
});

describe("the voice member list and the whiteboard", () => {
  it("marks the member whose board is open with a small board badge next to LIVE, and makes the row joinable", () => {
    inChannel("bob@n.test/DB");
    renderRow();
    const alice = row("alice@n.test");
    expect(within(alice).getByTestId("whiteboard-owner-badge")).toHaveAccessibleName("Whiteboard live");
    expect(alice).toHaveAttribute("data-whiteboard", "true");
    expect(alice).toHaveAttribute("tabindex", "0");
    expect(alice.getAttribute("title")).toContain("Doppelklick oder Enter: Whiteboard beitreten");
    // Nobody else has a board; the streamer keeps LIVE (and no board badge).
    expect(within(row("bob@n.test")).queryByTestId("whiteboard-owner-badge")).toBeNull();
    expect(within(row("carol@n.test")).queryByTestId("whiteboard-owner-badge")).toBeNull();
    expect(within(row("carol@n.test")).getByTestId("flag-streaming")).toBeInTheDocument();
    expect(row("bob@n.test")).not.toHaveAttribute("tabindex");
  });

  it("no board, no badge", () => {
    board.session = null;
    renderRow();
    expect(screen.queryByTestId("whiteboard-owner-badge")).toBeNull();
    expect(row("alice@n.test")).not.toHaveAttribute("data-whiteboard");
  });

  it("inside the channel a double-click or Enter on the owner joins the board and opens the stage", () => {
    inChannel("bob@n.test/DB");
    renderRow();
    fireEvent.doubleClick(row("alice@n.test"));
    expect(board.join).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("path")).toHaveTextContent("/rooms/R/channels/C");
    fireEvent.keyDown(row("alice@n.test"), { key: "Enter" });
    expect(board.join).toHaveBeenCalledTimes(2);
    expect(joinStream).not.toHaveBeenCalled();
    // A double-click on someone without a board does nothing; the streamer's row still joins the stream.
    fireEvent.doubleClick(row("bob@n.test"));
    expect(board.join).toHaveBeenCalledTimes(2);
    fireEvent.doubleClick(row("carol@n.test"));
    expect(joinStream).toHaveBeenCalledWith("carol@n.test/DC");
    expect(board.join).toHaveBeenCalledTimes(2);
  });

  it("outside the channel it only says to join the voice channel first", () => {
    inChannel("bob@n.test/DB", "OTHER");
    renderRow();
    fireEvent.doubleClick(row("alice@n.test"));
    expect(board.join).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts).toEqual([expect.objectContaining({ testId: "whiteboard-join-hint", title: "Tritt dem Sprachkanal bei, um das Whiteboard zu öffnen." })]);
    expect(screen.getByTestId("path")).toHaveTextContent("/rooms/R/channels/T");
  });

  it("the owner's own row brings the hidden preview back", () => {
    inChannel("alice@n.test/DA");
    board.isOwner = true;
    board.joined = true;
    useBoardPreview.setState({ shown: false });
    renderRow();
    act(() => fireEvent.doubleClick(row("alice@n.test")));
    expect(useBoardPreview.getState().shown).toBe(true);
    expect(board.join).not.toHaveBeenCalled();
    expect(screen.getByTestId("path")).toHaveTextContent("/rooms/R/channels/C");
  });
});
