// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MAX_SIGNAL_BYTES, SignalLimiter, encodeSoundSignal, parseClipEmoji, parseSoundSignal } from "./soundSignal";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const ID = "01J9ZZZZZZZZZZZZZZZZZZZZZZ";

describe("soundboard signal (design note 4.13 item 3)", () => {
  it("round-trips a clip start with its emoji and clamps the duration to the clip limits", () => {
    expect(parseSoundSignal(encodeSoundSignal({ id: ID, emoji: "🎺" }, 1234.4))).toEqual({ type: "soundboard.play", sound_id: ID, emoji: "🎺", duration_ms: 1234 });
    expect(parseSoundSignal(encodeSoundSignal({ id: ID }, 60_000))).toEqual({ type: "soundboard.play", sound_id: ID, duration_ms: 5000 });
    expect(parseSoundSignal(encodeSoundSignal({ id: ID, emoji: "not an emoji" }, 10))!.emoji).toBeUndefined();
    // Clips of other nodes carry their host (design note 4.13); malformed hosts are dropped.
    expect(parseSoundSignal(encodeSoundSignal({ id: ID, host: "b.test" }, 10))!.host).toBe("b.test");
    expect(parseSoundSignal(encodeSoundSignal({ id: ID, host: "evil/x" }, 10))!.host).toBeUndefined();
    expect(parseSoundSignal(new TextEncoder().encode(JSON.stringify({ type: "soundboard.play", sound_id: ID, duration_ms: 5, host: "a@b" })))!.host).toBeUndefined();
  });

  it("drops anything that is not a valid signal (untrusted input)", () => {
    expect(parseSoundSignal(enc("not json"))).toBeNull();
    expect(parseSoundSignal(enc({ type: "other", sound_id: ID, duration_ms: 10 }))).toBeNull();
    expect(parseSoundSignal(enc({ type: "soundboard.play", sound_id: "../x", duration_ms: 10 }))).toBeNull();
    expect(parseSoundSignal(enc({ type: "soundboard.play", sound_id: ID, duration_ms: "10" }))).toBeNull();
    expect(parseSoundSignal(enc({ type: "soundboard.play", sound_id: ID, duration_ms: Number.MAX_VALUE }))!.duration_ms).toBe(5000);
    expect(parseSoundSignal(enc({ type: "soundboard.play", sound_id: ID, duration_ms: -5 }))!.duration_ms).toBe(1);
    // Oversized packets, invalid UTF-8, markup in the emoji.
    expect(parseSoundSignal(enc({ type: "soundboard.play", sound_id: ID, duration_ms: 10, pad: "x".repeat(MAX_SIGNAL_BYTES) }))).toBeNull();
    expect(parseSoundSignal(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(parseSoundSignal(enc({ type: "soundboard.play", sound_id: ID, duration_ms: 10, emoji: "<img src=x onerror=alert(1)>" }))!.emoji).toBeUndefined();
  });

  it("accepts Unicode emojis and custom emoji tokens only", () => {
    expect(parseClipEmoji("🎉")).toEqual({ kind: "unicode", text: "🎉" });
    expect(parseClipEmoji("👍🏽")).toEqual({ kind: "unicode", text: "👍🏽" });
    expect(parseClipEmoji("🇩🇪")).toEqual({ kind: "unicode", text: "🇩🇪" });
    expect(parseClipEmoji("👨‍👩‍👧")).toEqual({ kind: "unicode", text: "👨‍👩‍👧" });
    expect(parseClipEmoji("<:tada:01J9ZZZZZZZZZZZZZZZZZZZZZZ@n.example>")).toEqual({ kind: "custom", name: "tada", id: "01J9ZZZZZZZZZZZZZZZZZZZZZZ", node: "n.example" });
    expect(parseClipEmoji("<a:party:01J9>")).toEqual({ kind: "custom", name: "party", id: "01J9", node: null });
    expect(parseClipEmoji(":tada:")).toEqual({ kind: "custom", name: "tada", id: null, node: null });
    for (const bad of ["", "abc", "123", "#", "🎉 hi", "<:x:1@evil.example/path>", "<script>"]) expect(parseClipEmoji(bad)).toBeNull();
  });

  it("limits signals per sender to five per ten seconds", () => {
    const l = new SignalLimiter(5, 10_000);
    for (let i = 0; i < 5; i++) expect(l.allow("a", i * 100)).toBe(true);
    expect(l.allow("a", 600)).toBe(false);
    expect(l.allow("b", 600)).toBe(true);
    expect(l.allow("a", 10_001)).toBe(true);
    l.forget("a");
    expect(l.allow("a", 10_002)).toBe(true);
  });
});
