// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { useNotifications } from "../../stores/notifications";
import { formatCallDuration } from "../../components/MessageList";
import { onEndEvent, onRingEvent } from "./actions";
import { useCalls } from "./state";

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
});
