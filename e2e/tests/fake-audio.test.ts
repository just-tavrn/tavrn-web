// SPDX-License-Identifier: Apache-2.0
// Unit test of the fake microphone's signal (node --test, no browser): `pnpm --filter @tavrn/e2e test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { speechWav } from "./fake-audio.ts";

const RATE = 48000;

/** dBFS of each 20 ms block of the WAV's samples. */
function blockLevels(wav: Buffer): number[] {
  const samples = (wav.length - 44) / 2;
  const block = RATE / 50;
  const out: number[] = [];
  for (let start = 0; start + block <= samples; start += block) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += (wav.readInt16LE(44 + i * 2) / 32768) ** 2;
    out.push(sum === 0 ? -Infinity : 10 * Math.log10(sum / block));
  }
  return out;
}

test("a mono 16-bit WAV of the requested length at 48 kHz", () => {
  const wav = speechWav(2);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 15), "WAVEfmt");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), RATE);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 2 * RATE * 2);
  assert.equal(wav.length, 44 + 2 * RATE * 2);
});

test("speech-like, not a steady tone: loud syllables with short pauses, never clipping", () => {
  const levels = blockLevels(speechWav(5));
  const loud = levels.filter((l) => l > -20).length;
  const quiet = levels.filter((l) => l < -60).length;
  // Mostly voiced (the speaking light stays on), with pauses a noise suppressor does not take for steady noise.
  assert.ok(loud > levels.length * 0.5, `voiced blocks: ${loud} of ${levels.length}`);
  assert.ok(quiet > levels.length * 0.1, `pauses: ${quiet} of ${levels.length}`);
  // No pause longer than the receiver's 150 ms hold of the speaking light (7 blocks of 20 ms).
  let run = 0;
  for (const l of levels) {
    run = l < -60 ? run + 1 : 0;
    assert.ok(run <= 7, "a pause longer than 140 ms");
  }
  const wav = speechWav(5);
  let peak = 0;
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  assert.ok(peak < 32000 && peak > 8000, `peak ${peak}`);
});

test("the same signal every time (runs stay comparable)", () => {
  assert.ok(speechWav(1).equals(speechWav(1)));
});
