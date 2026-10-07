// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_GRACE_MS, RejoinSchedule, participantStatus } from "./reconnect";

describe("rejoin after a disconnect (design note 4.5 item 7)", () => {
  it("backs off and stops before the node's grace period ends", () => {
    const s = new RejoinSchedule(0, 10_000);
    let now = 0;
    const delays: number[] = [];
    for (;;) {
      const d = s.next(now);
      if (d === null) break;
      delays.push(d);
      now += d + 300; // the attempt itself takes a moment
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(s.attempts).toBe(4);
    expect(now).toBeLessThan(10_000);
  });

  it("keeps trying every 8 s within the default grace period", () => {
    const s = new RejoinSchedule(1_000);
    let now = 1_000;
    let attempts = 0;
    for (let d = s.next(now); d !== null; d = s.next(now)) {
      attempts++;
      now += d;
    }
    expect(DEFAULT_GRACE_MS).toBe(45_000);
    expect(attempts).toBeGreaterThanOrEqual(7);
    expect(now).toBeLessThanOrEqual(1_000 + DEFAULT_GRACE_MS);
  });

  it("does not try at all without a grace period", () => {
    expect(new RejoinSchedule(0, 0).next(0)).toBeNull();
  });
});

describe("participant display state", () => {
  it("shows reconnecting from the node's flag or a lost LiveKit connection, never as speaking", () => {
    expect(participantStatus({ connection: "reconnecting" }, "excellent", 0.8)).toBe("reconnecting");
    expect(participantStatus({ connection: "connected" }, "lost", 0.8)).toBe("reconnecting");
  });

  it("shows speaking for unmuted participants with a level, poor connections otherwise", () => {
    expect(participantStatus({ connection: "connected" }, "good", 0.4)).toBe("speaking");
    expect(participantStatus({ connection: "connected", muted: true }, "good", 0.4)).toBe("idle");
    expect(participantStatus({ connection: "connected", server_muted: true }, "good", 0.4)).toBe("idle");
    expect(participantStatus({ connection: "connected" }, "poor", 0)).toBe("poor");
    expect(participantStatus({ connection: "connected" }, "poor", 0.3)).toBe("speaking");
    // Older nodes without the field, participants outside the own call (no quality known).
    expect(participantStatus({}, undefined, 0)).toBe("idle");
    expect(participantStatus({ connection: "something-new" }, undefined, 0)).toBe("idle");
  });
});
