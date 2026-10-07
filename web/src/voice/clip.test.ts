// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MAX_CLIP_BYTES, encodeWav } from "./clip";

describe("soundboard clip encoding (VOICE.md §8)", () => {
  it("writes a valid 16-bit mono WAV header and samples", () => {
    const left = Float32Array.from([0, 1, -1, 0.5]);
    const right = Float32Array.from([0, 1, -1, -0.5]);
    const wav = encodeWav([left, right], 8000);
    const view = new DataView(wav.buffer);
    const text = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.length).toBe(52);
    // Mixed down to mono: (0.5 + -0.5) / 2 = 0.
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 0]);
  });

  it("keeps only the first five seconds, which always fit the node's 1 MiB limit", () => {
    const rate = 48000;
    const seven = new Float32Array(rate * 7).fill(0.1);
    const wav = encodeWav([seven, seven], rate);
    expect(wav.length).toBe(44 + rate * 5 * 2);
    expect(wav.length).toBeLessThan(MAX_CLIP_BYTES);
  });
});
