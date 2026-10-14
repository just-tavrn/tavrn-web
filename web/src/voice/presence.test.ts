// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { VoiceParticipant } from "@tavrn/sdk";
import { channelKey, participantsOf, screensOf, sessionStartOf, useVoicePresence, voiceChannelOfUser } from "./presence";

function p(user: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant {
  const device = `D${user.length}`;
  return { user: `${user}@n.example`, user_id: `U-${user}`, device_id: device, identity: `${user}@n.example/${device}`, muted: false, deafened: false, streaming: false, camera: false, server_muted: false, joined_at: "2026-10-05T12:00:00.000Z", connection: "connected", ...extra };
}

describe("voice presence store (VOICE.md §5)", () => {
  beforeEach(() => useVoicePresence.getState().reset());

  it("replaces a channel's list with every voice.state (no merge) and drops empty channels", () => {
    const s = useVoicePresence.getState();
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 3, participants: [p("alice"), p("bob")] });
    expect(participantsOf(useVoicePresence.getState(), "n.example", "C").map((x) => x.user)).toEqual(["alice@n.example", "bob@n.example"]);
    expect(useVoicePresence.getState().epochs[channelKey("n.example", "C")]).toBe(3);
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 4, participants: [p("bob", { muted: true })] });
    const now = participantsOf(useVoicePresence.getState(), "n.example", "C");
    expect(now).toHaveLength(1);
    expect(now[0]!.muted).toBe(true);
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 4, participants: [] });
    expect(useVoicePresence.getState().channels[channelKey("n.example", "C")]).toBeUndefined();
    // A stable empty list (no re-render loops in selectors).
    expect(participantsOf(useVoicePresence.getState(), "n.example", "C")).toBe(participantsOf(useVoicePresence.getState(), "n.example", "X"));
  });

  it("keeps screen publishers apart from the people of a channel (VOICE.md §4b)", () => {
    const s = useVoicePresence.getState();
    const alice = p("alice", { streaming: true });
    const screen = p("alice", { identity: `${alice.identity}#screen`, screen_of: alice.identity, muted: true, streaming: true });
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [alice, screen, p("bob")] });
    const now = useVoicePresence.getState();
    expect(participantsOf(now, "n.example", "C").map((x) => x.identity)).toEqual([alice.identity, p("bob").identity]);
    expect(screensOf(now, "n.example", "C").map((x) => x.identity)).toEqual([screen.identity]);
    expect(voiceChannelOfUser(now, "n.example", "R", "U-alice")).toBe("C");
    // The share ends: the screen list goes, the people stay.
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [alice, p("bob")] });
    expect(screensOf(useVoicePresence.getState(), "n.example", "C")).toEqual([]);
    expect(participantsOf(useVoicePresence.getState(), "n.example", "C")).toHaveLength(2);
    // Seeds split the same way; a deleted channel takes its screens along.
    s.seedRoom("n.example", "R", [{ room_id: "R", channel_id: "C", epoch: 1, participants: [alice, screen] }]);
    expect(screensOf(useVoicePresence.getState(), "n.example", "C")).toHaveLength(1);
    s.seedAll("n.example", [{ room_id: "R", channels: [{ room_id: "R", channel_id: "C", epoch: 1, participants: [alice, screen] }] }]);
    expect(participantsOf(useVoicePresence.getState(), "n.example", "C")).toHaveLength(1);
    expect(screensOf(useVoicePresence.getState(), "n.example", "C")).toHaveLength(1);
    s.removeChannel("n.example", "C");
    expect(screensOf(useVoicePresence.getState(), "n.example", "C")).toEqual([]);
  });

  it("keeps the session start of each channel from every state and seed (VOICE.md §5)", () => {
    const s = useVoicePresence.getState();
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "C")).toBeNull();
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, session_started_at: "2026-10-14T12:00:00.000Z", participants: [p("alice")] });
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "C")).toBe("2026-10-14T12:00:00.000Z");
    // The last participant left: the node sends null (or an older node nothing); both read as "no session".
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, session_started_at: null, participants: [] });
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "C")).toBeNull();
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, session_started_at: "2026-10-14T13:00:00.000Z", participants: [p("bob")] });
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [p("bob")] });
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "C")).toBeNull();
    // Seeds carry it too and replace what the room or node had.
    s.seedRoom("n.example", "R", [{ room_id: "R", channel_id: "C", epoch: 1, session_started_at: "2026-10-14T14:00:00.000Z", participants: [p("bob")] }]);
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "C")).toBe("2026-10-14T14:00:00.000Z");
    s.seedAll("n.example", [{ room_id: "R", channels: [{ room_id: "R", channel_id: "D", epoch: 1, session_started_at: "2026-10-14T15:00:00.000Z", participants: [p("bob")] }] }]);
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "C")).toBeNull();
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "D")).toBe("2026-10-14T15:00:00.000Z");
    s.removeChannel("n.example", "D");
    expect(sessionStartOf(useVoicePresence.getState(), "n.example", "D")).toBeNull();
  });

  it("keeps channels of different nodes apart", () => {
    const s = useVoicePresence.getState();
    s.apply("a.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [p("alice")] });
    s.apply("b.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [p("bob")] });
    expect(participantsOf(useVoicePresence.getState(), "a.example", "C")[0]!.user).toBe("alice@n.example");
    expect(participantsOf(useVoicePresence.getState(), "b.example", "C")[0]!.user).toBe("bob@n.example");
  });

  it("seeds a room from GET …/voice, replacing that room's channels only", () => {
    const s = useVoicePresence.getState();
    s.apply("n.example", { room_id: "R", channel_id: "OLD", epoch: 1, participants: [p("ghost")] });
    s.apply("n.example", { room_id: "R2", channel_id: "OTHER", epoch: 1, participants: [p("carol")] });
    s.seedRoom("n.example", "R", [{ room_id: "R", channel_id: "C", epoch: 2, participants: [p("alice")] }]);
    const st = useVoicePresence.getState();
    expect(participantsOf(st, "n.example", "OLD")).toEqual([]);
    expect(participantsOf(st, "n.example", "C")).toHaveLength(1);
    expect(participantsOf(st, "n.example", "OTHER")).toHaveLength(1);
  });

  it("finds the voice channel a user is in and forgets deleted channels and rooms", () => {
    const s = useVoicePresence.getState();
    s.apply("n.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [p("alice")] });
    s.apply("n.example", { room_id: "R", channel_id: "C2", epoch: 1, participants: [p("bob")] });
    expect(voiceChannelOfUser(useVoicePresence.getState(), "n.example", "R", "U-bob")).toBe("C2");
    expect(voiceChannelOfUser(useVoicePresence.getState(), "n.example", "R", "U-nobody")).toBeNull();
    s.removeChannel("n.example", "C2");
    expect(voiceChannelOfUser(useVoicePresence.getState(), "n.example", "R", "U-bob")).toBeNull();
    s.clearRoom("n.example", "R");
    expect(useVoicePresence.getState().channels).toEqual({});
  });

  it("seeds every room of a node from GET /users/me/voice, replacing only that node's rooms", () => {
    const s = useVoicePresence.getState();
    s.apply("n.example", { room_id: "R", channel_id: "GONE", epoch: 1, participants: [p("ghost")] });
    s.apply("b.example", { room_id: "R", channel_id: "C", epoch: 1, participants: [p("bob")] });
    s.seedAll("n.example", [
      { room_id: "R", channels: [{ room_id: "R", channel_id: "C1", epoch: 2, participants: [p("alice")] }] },
      { room_id: "R2", channels: [{ room_id: "R2", channel_id: "C2", epoch: null, participants: [p("carol")] }] },
    ]);
    const st = useVoicePresence.getState();
    expect(participantsOf(st, "n.example", "GONE")).toHaveLength(0);
    expect(st.rooms[channelKey("n.example", "GONE")]).toBeUndefined();
    expect(voiceChannelOfUser(st, "n.example", "R", "U-alice")).toBe("C1");
    expect(voiceChannelOfUser(st, "n.example", "R2", "U-carol")).toBe("C2");
    expect(st.epochs[channelKey("n.example", "C1")]).toBe(2);
    expect(participantsOf(st, "b.example", "C")[0]!.user).toBe("bob@n.example");
    s.seedAll("n.example", []);
    expect(Object.keys(useVoicePresence.getState().channels)).toEqual([channelKey("b.example", "C")]);
  });
});
