// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { KEYRING_SIZE, VoiceKeyRing, voiceKeyIndex } from "./keys";

describe("voice frame keys (ENCRYPTION.md §5a)", () => {
  it("addresses the ring of the last 256 epochs by epoch mod 256", () => {
    expect(KEYRING_SIZE).toBe(256);
    expect(voiceKeyIndex(0)).toBe(0);
    expect(voiceKeyIndex(7)).toBe(7);
    expect(voiceKeyIndex(255)).toBe(255);
    expect(voiceKeyIndex(256)).toBe(0);
    expect(voiceKeyIndex(1000)).toBe(1000 % 256);
    expect(voiceKeyIndex(2 ** 40 + 3)).toBe(3);
  });

  it("rejects epochs that are not non-negative integers", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => voiceKeyIndex(bad)).toThrow();
  });

  it("tells which epochs still need a key and never goes back to an older epoch", () => {
    const ring = new VoiceKeyRing();
    expect(ring.current).toBeNull();
    expect(ring.needs(3)).toBe(true);
    ring.mark(3);
    expect(ring.current).toBe(3);
    expect(ring.needs(3)).toBe(false);
    // An older epoch (a late event) is not set again: the sending key stays the newest one.
    expect(ring.needs(2)).toBe(false);
    expect(ring.needs(4)).toBe(true);
    ring.mark(4);
    expect(ring.current).toBe(4);
    ring.reset();
    expect(ring.current).toBeNull();
  });
});
