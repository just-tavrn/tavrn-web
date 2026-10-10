// SPDX-License-Identifier: Apache-2.0
// The initial voice state of every room (GET /users/me/voice, VOICE.md §5) feeds the presence store at start.
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAuth } from "../stores/auth";
import { resetNodeCaches, useNodes } from "../stores/nodes";
import { mockFetch, renderWithProviders } from "../test/render";
import { channelKey, participantsOf, useVoicePresence } from "./presence";
import { useVoiceRealtime } from "./useVoiceRealtime";

const me = { id: "A-ID", username: "alice", domain: "a.test", address: "alice@a.test", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const bob = { user: "bob@a.test", user_id: "B", device_id: "D", identity: "bob@a.test/D", muted: false, deafened: false, streaming: true, camera: false, server_muted: false, joined_at: "", connection: "connected" };

function Harness() {
  useVoiceRealtime();
  return null;
}

beforeEach(() => {
  resetNodeCaches();
  useNodes.getState().clear();
  useVoicePresence.getState().reset();
  useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "D", home: null });
});

describe("GET /users/me/voice at start", () => {
  it("seeds every room of the home node and replaces what was known of it", async () => {
    useVoicePresence.getState().apply("a.test", { room_id: "OLD", channel_id: "GHOST", participants: [{ ...bob, user: "ghost@a.test" }] });
    const calls = mockFetch({ "/users/me/voice": { body: { rooms: [{ room_id: "R", channels: [{ room_id: "R", channel_id: "V", epoch: 1, participants: [bob] }] }] } } });
    renderWithProviders(<Harness />);
    await waitFor(() => expect(participantsOf(useVoicePresence.getState(), "a.test", "V").map((p) => p.user)).toEqual(["bob@a.test"]));
    expect(useVoicePresence.getState().rooms[channelKey("a.test", "V")]).toBe(channelKey("a.test", "R"));
    expect(participantsOf(useVoicePresence.getState(), "a.test", "GHOST")).toHaveLength(0);
    expect(calls.filter((c) => c.url.endsWith("/users/me/voice"))).toHaveLength(1);
  });

  it("a node without the route (404) leaves the store alone", async () => {
    useVoicePresence.getState().apply("a.test", { room_id: "R", channel_id: "V", participants: [bob] });
    const calls = mockFetch({});
    renderWithProviders(<Harness />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/users/me/voice"))).toBe(true));
    expect(participantsOf(useVoicePresence.getState(), "a.test", "V")).toHaveLength(1);
  });
});
