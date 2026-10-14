// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { isLocallyMuted, localMutedCount, setLocalMute, toggleLocalMute, useLocalMute } from "./localMute";

describe("local mute of other participants (issue #124)", () => {
  beforeEach(() => useLocalMute.setState({ muted: {} }));

  it("mutes and unmutes a user by address, for this session only", () => {
    expect(isLocallyMuted(useLocalMute.getState(), "bob@n")).toBe(false);
    setLocalMute("bob@n", true);
    expect(isLocallyMuted(useLocalMute.getState(), "bob@n")).toBe(true);
    expect(isLocallyMuted(useLocalMute.getState(), "alice@n")).toBe(false);
    setLocalMute("bob@n", false);
    expect(useLocalMute.getState().muted).toEqual({});
    // Nothing is written to storage: a reload starts with everybody audible.
    expect(Object.keys(localStorage).some((k) => k.includes("mute"))).toBe(false);
  });

  it("toggles and counts the muted participants of a list of addresses", () => {
    toggleLocalMute("bob@n");
    toggleLocalMute("carol@n");
    expect(localMutedCount(useLocalMute.getState(), ["alice@n", "bob@n", "carol@n", "bob@n"])).toBe(2);
    toggleLocalMute("bob@n");
    expect(localMutedCount(useLocalMute.getState(), ["alice@n", "bob@n", "carol@n"])).toBe(1);
  });
});
