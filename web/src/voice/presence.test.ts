// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { VoiceParticipant } from "@tavrn/sdk";
import { channelKey, participantsOf, useVoicePresence, voiceChannelOfUser } from "./presence";

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
});
