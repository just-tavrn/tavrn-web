// SPDX-License-Identifier: Apache-2.0
// After a moderator's move (`voice.move`, VOICE.md §7) the view follows to the target channel when the old voice
// channel was open, and a toast names the new channel either way (issue #196). Tests run in German (test/setup.ts).
import { act, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TavrnSocket } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { resetNodeCaches, useNodes } from "../stores/nodes";
import { useToasts } from "../stores/toasts";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { mockFetch, renderWithProviders } from "../test/render";
import { followedPath, followMoveView } from "./moveFollow";
import { useVoiceRealtime } from "./useVoiceRealtime";

const h = vi.hoisted(() => ({ followMove: vi.fn(async (_domain: string, _data: unknown) => true) }));
vi.mock("./index", async (importOriginal) => ({ ...(await importOriginal<typeof import("./index")>()), followMove: h.followMove }));

const me = { id: "A-ID", username: "alice", domain: "a.test", address: "alice@a.test", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const move = { room_id: "R", from_channel_id: "V1", channel_id: "V2", user_id: "A-ID" };
const room = (channels: Array<{ id: string; name: string; system_name?: string | null }>) => ({ id: "R", name: "Room", channels: channels.map((c) => ({ kind: "voice", system_name: null, ...c })) });

beforeEach(() => {
  resetNodeCaches();
  useNodes.getState().clear();
  useToasts.setState({ toasts: [] });
  useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "D", home: null });
  h.followMove.mockReset();
  h.followMove.mockResolvedValue(true);
});

afterEach(() => {
  useRealtimeState.setState({ socket: null });
  useNodeSockets.setState({ sockets: {} });
});

describe("followedPath: navigate only when the old voice channel is open", () => {
  it("the old channel of the home node is open: its target channel", () => {
    expect(followedPath("/rooms/R/channels/V1", "a.test", move)).toBe("/rooms/R/channels/V2");
  });

  it("a federated room: the target under the same node's routes", () => {
    expect(followedPath("/n/b.test/rooms/R/channels/V1", "b.test", move)).toBe("/n/b.test/rooms/R/channels/V2");
    // The same ids on the home node's routes are another room.
    expect(followedPath("/rooms/R/channels/V1", "b.test", move)).toBeNull();
  });

  it("any other route stays", () => {
    expect(followedPath("/rooms/R/channels/T", "a.test", move)).toBeNull();
    expect(followedPath("/rooms/R/channels/V10", "a.test", move)).toBeNull();
    expect(followedPath("/rooms/R", "a.test", move)).toBeNull();
    expect(followedPath("/conversations/V1", "a.test", move)).toBeNull();
    expect(followedPath("/", "a.test", move)).toBeNull();
  });
});

describe("followMoveView", () => {
  it("navigates from the old channel and names the new one in a toast", async () => {
    const client = new QueryClient();
    client.setQueryData(["room", "R"], room([{ id: "V1", name: "one" }, { id: "V2", name: "Lounge" }]));
    const navigate = vi.fn();
    await followMoveView({ domain: "a.test", data: move, pathname: "/rooms/R/channels/V1", navigate, queryClient: client });
    expect(navigate).toHaveBeenCalledWith("/rooms/R/channels/V2");
    expect(useToasts.getState().toasts).toMatchObject([{ kind: "info", title: "Du wurdest nach #Lounge verschoben", testId: "voice-moved" }]);
    // Already there: no jump link.
    expect(useToasts.getState().toasts[0]!.path).toBeUndefined();
  });

  it("keeps another route, but the toast still appears and links the new channel", async () => {
    const client = new QueryClient();
    client.setQueryData(["room", "R"], room([{ id: "V2", name: "Lounge" }]));
    const navigate = vi.fn();
    await followMoveView({ domain: "b.test", data: move, pathname: "/n/b.test/rooms/R/channels/T", navigate, queryClient: client });
    expect(navigate).not.toHaveBeenCalled();
    expect(useToasts.getState().toasts).toMatchObject([{ title: "Du wurdest nach #Lounge verschoben", path: "/n/b.test/rooms/R/channels/V2" }]);
  });

  it("default channels are named localized", async () => {
    const client = new QueryClient();
    client.setQueryData(["room", "R"], room([{ id: "V2", name: "general-voice", system_name: "voice" }]));
    await followMoveView({ domain: "a.test", data: move, pathname: "/", navigate: vi.fn(), queryClient: client });
    expect(useToasts.getState().toasts[0]!.title).toBe("Du wurdest nach #Sprache verschoben");
  });

  it("an unknown room is fetched for the name; without one the toast still tells about the move", async () => {
    mockFetch({ "/rooms/R": { body: room([{ id: "V2", name: "Fetched" }]) } });
    await followMoveView({ domain: "a.test", data: move, pathname: "/", navigate: vi.fn(), queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    expect(useToasts.getState().toasts[0]!.title).toBe("Du wurdest nach #Fetched verschoben");
    useToasts.setState({ toasts: [] });
    mockFetch({});
    await followMoveView({ domain: "a.test", data: move, pathname: "/", navigate: vi.fn(), queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    expect(useToasts.getState().toasts[0]!.title).toBe("Du wurdest in einen anderen Sprachkanal verschoben");
  });
});

describe("the voice.move event", () => {
  function fakeSocket() {
    const handlers = new Map<string, (d: unknown) => void>();
    const socket = { on: (event: string, fn: (d: unknown) => void) => (handlers.set(event, fn), () => handlers.delete(event)) } as unknown as TavrnSocket;
    return { socket, emit: (event: string, d: unknown) => handlers.get(event)?.(d) };
  }

  function Harness() {
    useVoiceRealtime();
    return <p data-testid="path">{useLocation().pathname}</p>;
  }

  it("follows to the target channel once the rejoin succeeded", async () => {
    mockFetch({ "/rooms/R": { body: room([{ id: "V2", name: "Lounge" }]) } });
    const { socket, emit } = fakeSocket();
    useRealtimeState.setState({ socket });
    renderWithProviders(<Harness />, { route: "/rooms/R/channels/V1" });
    await act(async () => emit("voice.move", move));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/rooms/R/channels/V2"));
    expect(h.followMove).toHaveBeenCalledWith("a.test", move);
    await waitFor(() => expect(useToasts.getState().toasts.map((x) => x.title)).toEqual(["Du wurdest nach #Lounge verschoben"]));
  });

  it("a federated node's move follows under its routes", async () => {
    mockFetch({ "/rooms/R": { body: room([{ id: "V2", name: "Lounge" }]) } });
    const { socket, emit } = fakeSocket();
    useNodeSockets.setState({ sockets: { "b.test": socket } });
    renderWithProviders(<Harness />, { route: "/n/b.test/rooms/R/channels/V1" });
    await act(async () => emit("voice.move", move));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/n/b.test/rooms/R/channels/V2"));
    expect(h.followMove).toHaveBeenCalledWith("b.test", move);
  });

  it("a move that was not followed (failed, left voice meanwhile, not ours) changes nothing", async () => {
    h.followMove.mockResolvedValue(false);
    const { socket, emit } = fakeSocket();
    useRealtimeState.setState({ socket });
    renderWithProviders(<Harness />, { route: "/rooms/R/channels/V1" });
    await act(async () => emit("voice.move", move));
    await waitFor(() => expect(h.followMove).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.getByTestId("path").textContent).toBe("/rooms/R/channels/V1");
    expect(useToasts.getState().toasts).toEqual([]);
  });
});
