// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission, type VoiceParticipant } from "@tavrn/sdk";

// The voice channel's member list in the sidebar: the whiteboard badge next to LIVE, and joining the board with a
// double-click or Enter on its owner (docs/CLIENT.md "Streams are joined", the whiteboard follows that model).

const board = vi.hoisted(() => ({
  session: null as null | { owner: string; device_id: string },
  isOwner: false,
  joined: false,
  join: vi.fn(),
}));
vi.mock("../../whiteboard/store", () => ({ useWhiteboardSession: () => ({ ...board, leave: vi.fn(), thumbnailUrl: null, controller: { participants: new Map() } }) }));
const api = vi.hoisted(() => ({ voice: { move: vi.fn(async () => undefined) } }));
/** Permissions per channel id (everything unless a test narrows a channel). */
const perms = vi.hoisted(() => ({ byChannel: {} as Record<string, bigint>, all: (1n << 63n) - 1n }));
vi.mock("../../components/NodeScope", () => ({ useNode: () => ({ api, domain: "n.test", me: { id: "u-bob" }, roomPath: (r: string, c?: string) => `/rooms/${r}/channels/${c}` }) }));
vi.mock("../../pages/ChannelPage", () => ({ channelPermissions: (_room: unknown, channelId: string) => perms.byChannel[channelId] ?? perms.all, useRoomMembers: () => ({ data: [] }) }));
vi.mock("../useVoiceRealtime", () => ({ useRoomVoiceStates: () => undefined }));
vi.mock("../index", () => ({ joinStream: vi.fn(), joinVoice: vi.fn(async () => undefined) }));
vi.mock("../../components/menus/ChannelMenu", () => ({ useChannelMenu: () => ({ menu: { triggerProps: {} }, overlay: null }) }));
vi.mock("./useParticipantMenu", () => ({ useParticipantMenu: () => ({ menu: { triggerProps: {} }, overlay: null }) }));
vi.mock("../../components/ContextMenu", () => ({ MenuButton: () => null }));
vi.mock("./AvatarTile", () => ({ AvatarTile: () => null }));
vi.mock("../../lib/channelPermissions", () => ({ channelAccessMarks: () => [] }));

const { VoiceChannelRow } = await import("./VoiceChannelRow");
const { joinStream, joinVoice } = await import("../index");
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
const raid = { id: "D", kind: "voice", name: "Raid" } as never;

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
  perms.byChannel = {};
  api.voice.move.mockClear();
  vi.mocked(joinVoice).mockClear();
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

/** A stand-in for the browser's DataTransfer (jsdom has none). */
function dataTransfer() {
  const data: Record<string, string> = {};
  return {
    types: [] as string[],
    effectAllowed: "",
    dropEffect: "",
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? "",
    // `types` as the browser fills it on setData.
    get filled() {
      return Object.keys(data);
    },
  };
}

function renderTwo() {
  return render(
    <MemoryRouter initialEntries={["/rooms/R/channels/T"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <VoiceChannelRow room={room} channel={channel} onNavigate={() => undefined} />
              <VoiceChannelRow room={room} channel={raid} onNavigate={() => undefined} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const channelBox = (id: string) => screen.getAllByTestId("voice-channel").find((el) => el.getAttribute("data-channel") === id)!;

/** Drags `source` over `target` and returns the drop indicator; `drop` finishes with a drop. */
function dragOver(source: HTMLElement, target: HTMLElement, drop = false) {
  const dt = dataTransfer();
  fireEvent.dragStart(source, { dataTransfer: dt });
  const during = { ...dt, types: dt.filled };
  fireEvent.dragOver(target, { dataTransfer: during });
  const state = target.getAttribute("data-drop");
  if (drop) fireEvent.drop(target, { dataTransfer: during });
  fireEvent.dragEnd(source, { dataTransfer: dt });
  return state;
}

describe("moving by drag and drop (issue #119)", () => {
  it("the own row is draggable while connected in this channel; others' rows need move_members", () => {
    inChannel("bob@n.test/DB");
    renderRow();
    expect(row("bob@n.test")).toHaveAttribute("draggable", "true");
    expect(row("bob@n.test").getAttribute("title")).toContain("Auf einen anderen Sprachkanal ziehen, um dorthin zu wechseln");
    expect(row("alice@n.test")).toHaveAttribute("draggable", "true");
    // Without move_members only the own row stays draggable.
    perms.byChannel.C = perms.all & ~Permission.MOVE_MEMBERS;
    act(() => inChannel("bob@n.test/DB", "OTHER"));
    act(() => inChannel("bob@n.test/DB"));
    expect(row("bob@n.test")).toHaveAttribute("draggable", "true");
    expect(row("alice@n.test")).not.toHaveAttribute("draggable");
    // Not connected here (another channel of the room, or idle): the own row is a plain row.
    act(() => inChannel("bob@n.test/DB", "OTHER"));
    expect(row("bob@n.test")).not.toHaveAttribute("draggable");
    act(() => useVoice.setState(IDLE));
    expect(row("bob@n.test")).not.toHaveAttribute("draggable");
  });

  it("dragging yourself onto a channel you may join highlights it and joins it on drop", () => {
    inChannel("bob@n.test/DB");
    renderTwo();
    expect(dragOver(row("bob@n.test"), channelBox("D"), true)).toBe("accept");
    expect(joinVoice).toHaveBeenCalledWith({ domain: "n.test", roomId: "R", channelId: "D" }, { canCreate: true });
    expect(api.voice.move).not.toHaveBeenCalled();
    expect(channelBox("D")).not.toHaveAttribute("data-drop");
  });

  it("a channel you may not join refuses the drop visibly; the own channel is no target", () => {
    perms.byChannel.D = perms.all & ~Permission.CONNECT;
    inChannel("bob@n.test/DB");
    renderTwo();
    expect(dragOver(row("bob@n.test"), channelBox("D"), true)).toBe("refuse");
    expect(joinVoice).not.toHaveBeenCalled();
    expect(dragOver(row("bob@n.test"), channelBox("C"), true)).toBeNull();
    expect(joinVoice).not.toHaveBeenCalled();
  });

  it("a moderator drags another participant: the node moves them; without move_members in the target it is refused", async () => {
    inChannel("bob@n.test/DB");
    renderTwo();
    expect(dragOver(row("alice@n.test"), channelBox("D"), true)).toBe("accept");
    await act(() => Promise.resolve());
    expect(api.voice.move).toHaveBeenCalledWith("R", "C", "alice@n.test", "D");
    expect(joinVoice).not.toHaveBeenCalled();
    perms.byChannel.D = perms.all & ~Permission.MOVE_MEMBERS;
    act(() => inChannel("bob@n.test/DB", "OTHER"));
    act(() => inChannel("bob@n.test/DB"));
    expect(dragOver(row("alice@n.test"), channelBox("D"), true)).toBe("refuse");
    expect(api.voice.move).toHaveBeenCalledTimes(1);
  });
});
