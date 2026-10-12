// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { useNotifications } from "../../stores/notifications";
import { formatCallDuration } from "../../components/MessageList";
import { applyCall, onEndEvent, onRingEvent } from "./actions";
import { callKey, useCalls } from "./state";
import { participantsOf, screensOf, useVoicePresence } from "../presence";

const ring = (over: Record<string, unknown> = {}) => ({ conversation_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", node: "a.test", from: "alice@a.test", started_at: new Date().toISOString(), group: false, ...over });

describe("incoming calls (VOICE.md §11.2)", () => {
  beforeEach(() => {
    useCalls.getState().reset();
    useNotifications.setState({ entries: [] });
  });

  it("ring and put one entry into the notification center, also when two nodes announce it", () => {
    onRingEvent("a.test", ring());
    onRingEvent("b.test", ring());
    expect(Object.keys(useCalls.getState().ringing)).toHaveLength(1);
    const entries = useNotifications.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "call", path: "/n/a.test/conversations/01J9ZZZZZZZZZZZZZZZZZZZZZZ", read: false });
    expect(entries[0]!.title).toContain("alice");
    onEndEvent("a.test", { conversation_id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", node: "a.test", reason: "missed" });
    expect(useCalls.getState().ringing).toEqual({});
    // A stale ring (older than the ring time) neither rings nor notifies.
    onRingEvent("a.test", ring({ started_at: new Date(Date.now() - 60_000).toISOString(), conversation_id: "01J9YYYYYYYYYYYYYYYYYYYYYY" }));
    expect(useNotifications.getState().entries).toHaveLength(1);
  });

  it("formats call durations for the system message", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(42)).toBe("0:42");
    expect(formatCallDuration(725)).toBe("12:05");
    expect(formatCallDuration(3729)).toBe("1:02:09");
    expect(formatCallDuration(-5)).toBe("0:00");
  });

  it("counts a call's people without screen publishers, whose streams go to the stage (VOICE.md §4b)", () => {
    const id = "01J9ZZZZZZZZZZZZZZZZZZZZZZ";
    const person = (user: string, extra: Record<string, unknown> = {}) => ({ user, user_id: `U-${user}`, device_id: "D", identity: `${user}/D`, muted: false, deafened: false, streaming: false, camera: false, server_muted: false, joined_at: "2026-10-12T12:00:00.000Z", connection: "connected" as const, ...extra });
    const alice = person("alice@a.test", { streaming: true });
    const screen = person("alice@a.test", { identity: "alice@a.test/D#screen", screen_of: "alice@a.test/D", muted: true, streaming: true });
    applyCall("a.test", { conversation_id: id, active: true, started_by: "alice@a.test", started_at: new Date().toISOString(), group: false, participants: [alice, screen, person("bob@b.test")], ringing: [] });
    expect(useCalls.getState().calls[callKey("a.test", id)]?.participants.map((p) => p.identity)).toEqual(["alice@a.test/D", "bob@b.test/D"]);
    expect(participantsOf(useVoicePresence.getState(), "a.test", id)).toHaveLength(2);
    expect(screensOf(useVoicePresence.getState(), "a.test", id).map((p) => p.identity)).toEqual(["alice@a.test/D#screen"]);
  });
});
