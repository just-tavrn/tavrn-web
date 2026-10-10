// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { VoiceParticipant } from "@tavrn/sdk";
import { useVoicePresence } from "./presence";
import { NO_VOICE, avatarSlice, mergeVoice, roomVoice, roomVoiceSignature, voiceBadge, voiceLocationOf } from "./roomActivity";

function p(user: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return { user: `${user}@n.example`, user_id: `U-${user}`, device_id: "D1", identity: `${user}@n.example/D1`, muted: false, deafened: false, streaming: false, camera: false, server_muted: false, joined_at: "2026-10-05T12:00:00.000Z", connection: "connected", ...extra };
}
const state = () => useVoicePresence.getState();

describe("room voice activity (rail badges, hover card)", () => {
  beforeEach(() => state().reset());

  it("groups a room's channels with their participants and counts distinct users", () => {
    state().apply("n.example", { room_id: "R", channel_id: "C2", participants: [p("carol")] });
    state().apply("n.example", { room_id: "R", channel_id: "C1", participants: [p("alice"), p("bob")] });
    state().apply("n.example", { room_id: "OTHER", channel_id: "C9", participants: [p("dave")] });
    state().apply("b.example", { room_id: "R", channel_id: "C1", participants: [p("eve")] });
    const v = roomVoice(state(), "n.example", "R");
    expect(v.channels.map((c) => [c.channelId, c.participants.map((x) => x.user)])).toEqual([
      ["C1", ["alice@n.example", "bob@n.example"]],
      ["C2", ["carol@n.example"]],
    ]);
    expect(v.count).toBe(3);
    expect(v.streaming).toBe(false);
    expect(roomVoice(state(), "n.example", "EMPTY")).toBe(NO_VOICE);
    expect(roomVoiceSignature(state(), "n.example", "R")).toBe("3:0");
    expect(roomVoiceSignature(state(), "n.example", "EMPTY")).toBe("");
  });

  it("badge: the monitor (streaming) takes precedence over the speaker", () => {
    expect(voiceBadge({ count: 0, streaming: false })).toBeNull();
    expect(voiceBadge({ count: 2, streaming: false })).toBe("voice");
    expect(voiceBadge({ count: 2, streaming: true })).toBe("stream");
    state().apply("n.example", { room_id: "R", channel_id: "C1", participants: [p("alice"), p("bob", { streaming: true })] });
    expect(voiceBadge(roomVoice(state(), "n.example", "R"))).toBe("stream");
    expect(roomVoiceSignature(state(), "n.example", "R")).toBe("2:1");
    expect(mergeVoice([{ count: 1, streaming: false }, { count: 2, streaming: true }])).toEqual({ count: 3, streaming: true });
  });

  it("limits the avatars over all channels and counts the rest per channel", () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    expect(avatarSlice([{ participants: many(5, "a") }, { participants: many(6, "b") }], 8)).toEqual([
      { shown: many(5, "a"), more: 0 },
      { shown: many(3, "b"), more: 3 },
    ]);
    expect(avatarSlice([{ participants: many(9, "a") }, { participants: many(2, "b") }], 8)).toEqual([
      { shown: many(8, "a"), more: 1 },
      { shown: [], more: 2 },
    ]);
  });
});

describe("where a friend is in voice", () => {
  beforeEach(() => state().reset());

  it("finds the channel only in rooms the viewer is a member of (the store holds viewable channels only)", () => {
    state().apply("n.example", { room_id: "R", channel_id: "C1", participants: [p("alice")] });
    state().apply("b.example", { room_id: "R2", channel_id: "C7", participants: [p("bob")] });
    const rooms = new Set(["n.example/R", "b.example/R2"]);
    expect(voiceLocationOf(state(), "Alice@N.example", rooms)).toEqual({ domain: "n.example", roomId: "R", channelId: "C1" });
    expect(voiceLocationOf(state(), "bob@n.example", rooms)).toEqual({ domain: "b.example", roomId: "R2", channelId: "C7" });
    // Not a member of the room (left it, stale entry): nothing.
    expect(voiceLocationOf(state(), "alice@n.example", new Set(["b.example/R2"]))).toBeNull();
    // A channel the node never told the viewer about is not in the store: nothing.
    expect(voiceLocationOf(state(), "carol@n.example", rooms)).toBeNull();
  });
});
