// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attach = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock("../index", () => ({
  joinStream: vi.fn(),
  leaveStream: vi.fn(),
  stopScreenShare: vi.fn(async () => undefined),
  toggleMute: vi.fn(async () => undefined),
  toggleDeafen: vi.fn(async () => undefined),
  leaveVoice: vi.fn(async () => undefined),
  loadedSession: () => ({ attachVideo: attach }),
}));

const { ScreenTile, StreamingIndicator } = await import("./ScreenTile");
const { joinStream, leaveStream, stopScreenShare } = await import("../index");
const { IDLE, useVoice, useWatchedStreams } = await import("../store");
type Tile = import("./VoiceStage").Tile;

const flags = { muted: false, deafened: false, server_muted: false, streaming: true, camera: false };
const bob: Tile = { identity: "bob@a.test/1", address: "bob@a.test", name: "Bob", self: false, camera: false, flags, connection: "connected", participant: null };
const me: Tile = { ...bob, identity: "alice@a.test/1", address: "alice@a.test", name: "Alice", self: true };

function streamMedia(identity: string, video: boolean) {
  return { [identity]: { camera: false, screen: true, screenVideo: video, micMuted: false, screenAudio: true } };
}

beforeEach(() => {
  vi.mocked(joinStream).mockClear();
  vi.mocked(leaveStream).mockClear();
  vi.mocked(stopScreenShare).mockClear();
  attach.mockClear();
  useWatchedStreams.setState({ watching: {} });
  useVoice.setState({ ...IDLE, status: "connected", identity: me.identity, media: streamMedia(bob.identity, false) });
});

afterEach(() => useVoice.setState(IDLE));

describe("stream tiles: screen shares are joined (opt-in)", () => {
  it("before joining: name, LIVE badge and one button to join; no video, nothing watched", () => {
    render(<ScreenTile tile={bob} focused={false} onFocus={() => undefined} />);
    const el = screen.getByTestId("screen-tile");
    expect(el).toHaveAttribute("data-state", "available");
    expect(within(el).getByText("Bob")).toBeInTheDocument();
    expect(within(el).getByText("Live")).toBeInTheDocument();
    expect(el.querySelector("video")).toBeNull();
    expect(within(el).queryByTestId("screen-focus")).toBeNull();
    expect(useWatchedStreams.getState().watching).toEqual({});
    const join = within(el).getByRole("button", { name: "Stream beitreten (Bob)" });
    expect(join).toHaveTextContent("Stream beitreten");
    fireEvent.click(join);
    expect(joinStream).toHaveBeenCalledWith(bob.identity);
  });

  it("a double-click on the tile joins as well", () => {
    render(<ScreenTile tile={bob} focused={false} onFocus={() => undefined} />);
    fireEvent.doubleClick(screen.getByTestId("screen-tile"));
    expect(joinStream).toHaveBeenCalledWith(bob.identity);
  });

  it("joined: connecting until the video arrives, then the video; leaving goes back to the placeholder", () => {
    useVoice.setState({ streams: { [bob.identity]: true } });
    const view = render(<ScreenTile tile={bob} focused={false} onFocus={() => undefined} />);
    const el = screen.getByTestId("screen-tile");
    expect(el).toHaveAttribute("data-state", "watching");
    expect(within(el).getByTestId("stream-connecting")).toBeInTheDocument();
    expect(useWatchedStreams.getState().watching).toEqual({ [bob.identity]: 1 });
    act(() => useVoice.setState({ media: streamMedia(bob.identity, true) }));
    expect(within(el).queryByTestId("stream-connecting")).toBeNull();
    expect(attach).toHaveBeenCalledWith(bob.identity, "screen", expect.any(HTMLVideoElement));
    expect(within(el).getByTestId("screen-focus")).toBeInTheDocument();
    fireEvent.click(within(el).getByRole("button", { name: "Stream verlassen (Bob)" }));
    expect(leaveStream).toHaveBeenCalledWith(bob.identity);
    act(() => useVoice.setState({ streams: {} }));
    expect(screen.getByTestId("screen-tile")).toHaveAttribute("data-state", "available");
    expect(useWatchedStreams.getState().watching).toEqual({});
    view.unmount();
  });

  it("the own share is a preview that can be hidden (no permanent self view)", () => {
    useVoice.setState({ screen: true, media: streamMedia(me.identity, true) });
    render(<ScreenTile tile={me} focused={false} onFocus={() => undefined} />);
    const el = screen.getByTestId("screen-tile");
    expect(el).toHaveAttribute("data-state", "preview");
    expect(within(el).queryByRole("button", { name: /Stream beitreten/ })).toBeNull();
    fireEvent.click(within(el).getByRole("button", { name: "Vorschau ausblenden" }));
    expect(useVoice.getState().selfPreview).toBe(false);
  });
});

describe("the sharer's indicator", () => {
  it("only while sharing: says so, stops the share, and hides or reopens the preview", () => {
    const view = render(<StreamingIndicator />);
    expect(screen.queryByTestId("streaming-indicator")).toBeNull();
    act(() => useVoice.setState({ screen: true }));
    const bar = screen.getByTestId("streaming-indicator");
    expect(bar).toHaveTextContent("Du streamst");
    fireEvent.click(within(bar).getByRole("button", { name: "Vorschau ausblenden" }));
    expect(useVoice.getState().selfPreview).toBe(false);
    fireEvent.click(within(bar).getByRole("button", { name: "Vorschau zeigen" }));
    expect(useVoice.getState().selfPreview).toBe(true);
    fireEvent.click(within(bar).getByRole("button", { name: "Teilen beenden" }));
    expect(stopScreenShare).toHaveBeenCalled();
    view.unmount();
  });
});
