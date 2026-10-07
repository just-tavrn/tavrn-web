// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { CallState } from "@tavrn/sdk";
import { EMPTY, RING_MS, callKey, expireRings, onEnd, onRing, onUpdate, type Ring } from "./state";

const NOW = Date.parse("2026-10-05T10:00:10Z");
const ring = (over: Partial<Ring> = {}): Ring => ({ domain: "a.test", conversationId: "C1", from: "alice@a.test", startedAt: "2026-10-05T10:00:00Z", group: false, receivedAt: NOW, ...over });
const call = (over: Partial<CallState> = {}): CallState => ({ conversation_id: "C1", active: true, started_by: "alice@a.test", started_at: "2026-10-05T10:00:00Z", group: false, participants: [], ringing: ["bob@b.test"], ...over });
const KEY = callKey("a.test", "C1");

describe("call state machine (VOICE.md §11)", () => {
  it("rings unless the device is in the call already, declined it, or the ring is stale", () => {
    expect(onRing(EMPTY, ring(), { inCall: false, now: NOW }).ringing[KEY]?.from).toBe("alice@a.test");
    expect(onRing(EMPTY, ring(), { inCall: true, now: NOW })).toBe(EMPTY);
    expect(onRing(EMPTY, ring(), { inCall: false, now: NOW, declined: true })).toBe(EMPTY);
    expect(onRing(EMPTY, ring(), { inCall: false, now: NOW + RING_MS })).toBe(EMPTY);
  });

  it("stops ringing once the call was answered on another device or ended", () => {
    const ringing = onRing(EMPTY, ring(), { inCall: false, now: NOW });
    const still = onUpdate(ringing, "a.test", call(), "bob@b.test");
    expect(still.ringing[KEY]).toBeDefined();
    expect(still.calls[KEY]?.active).toBe(true);
    const answered = onUpdate(still, "a.test", call({ ringing: [] }), "bob@b.test");
    expect(answered.ringing[KEY]).toBeUndefined();
    expect(answered.calls[KEY]).toBeDefined();
    const over = onUpdate(answered, "a.test", call({ active: false, ringing: [] }), "bob@b.test");
    expect(over.calls[KEY]).toBeUndefined();
  });

  it("ends: missed and ended remove the call, answered/declined only the ring", () => {
    const s = onUpdate(onRing(EMPTY, ring(), { inCall: false, now: NOW }), "a.test", call(), "bob@b.test");
    const declined = onEnd(s, "a.test", "C1", "declined");
    expect(declined.ringing[KEY]).toBeUndefined();
    expect(declined.calls[KEY]).toBeDefined();
    const missed = onEnd(s, "a.test", "C1", "missed");
    expect(missed).toEqual(EMPTY);
  });

  it("drops rings whose end event got lost", () => {
    const s = onRing(EMPTY, ring(), { inCall: false, now: NOW });
    expect(expireRings(s, NOW + 1000)).toBe(s);
    expect(expireRings(s, NOW + RING_MS + 1).ringing).toEqual({});
  });
});
