// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { addressedWhisper, encodeWhisperSignal, parseWhisperSignal, WhisperLimiter } from "./whisperSignal";
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
describe("whisper control boundary", () => {
  it("round trips start and end with exact recipient identities", () => {
    for (const type of ["whisper.start", "whisper.end"] as const) expect(parseWhisperSignal(encodeWhisperSignal(type, ["a@n/d", "b@n/d"]))).toEqual({ type, recipients: ["a@n/d", "b@n/d"] });
  });
  it("rejects malformed, oversized and ambiguous packets", () => {
    for (const recipients of [[], [""], ["a\nb"], ["a", "a"], [42]]) expect(parseWhisperSignal(bytes({ type: "whisper.start", recipients }))).toBeNull();
    expect(parseWhisperSignal(bytes({ type: "whisper.start", recipients: ["a@n/d"], extra: true }))).toMatchObject({ type: "whisper.start" });
    expect(parseWhisperSignal(bytes({ type: "other", recipients: ["a@n/d"] }))).toBeNull();
    expect(parseWhisperSignal(new Uint8Array([0xff]))).toBeNull();
    expect(parseWhisperSignal(new Uint8Array(513))).toBeNull();
    expect(() => encodeWhisperSignal("whisper.start", ["x".repeat(321)])).toThrow();
  });
  it("limits each sender independently with an exact ten-second window", () => {
    const l = new WhisperLimiter();
    for (let i = 0; i < 10; i++) expect(l.allow("a", i)).toBe(true);
    expect(l.allow("a", 9999)).toBe(false);
    expect(l.allow("b", 9999)).toBe(true);
    expect(l.allow("a", 10000)).toBe(true);
    l.forget("a"); expect(l.allow("a", 10001)).toBe(true);
  });
});


it("authorizes only the addressed device of the current channel over reliable transport", () => {
  const members = new Set(["a@n/d", "b@n/d", "c@n/d"]);
  const data = encodeWhisperSignal("whisper.start", ["b@n/d"]);
  expect(addressedWhisper(data, "b@n/d", "a@n/d", members, true)).not.toBeNull();
  expect(addressedWhisper(data, "c@n/d", "a@n/d", members, true)).toBeNull();
  expect(addressedWhisper(data, "b@n/d", "a@n/other-device", members, true)).toBeNull();
  expect(addressedWhisper(data, "b@n/d", "a@n/d", members, false)).toBeNull();
  expect(addressedWhisper(encodeWhisperSignal("whisper.start", ["b@n/d", "gone@n/d"]), "b@n/d", "a@n/d", members, true)).toBeNull();
});
