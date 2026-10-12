// SPDX-License-Identifier: Apache-2.0
/**
 * The fake microphone's signal (Chromium's `--use-file-for-fake-audio-capture`, looped). It has to sound like speech
 * to the browser's audio processing: a steady tone is what a noise suppressor learns as noise and takes down by about
 * 20 dB (WebRTC's, the client's default "browser" noise suppression), which left the other side's speaking light near
 * its -50 dBFS threshold and sometimes dark (tavrn-web issue #47). So: syllables of a voiced sound (a harmonic series
 * on a gliding pitch, 110-200 Hz) with a soft envelope and short pauses, deterministic so runs stay comparable.
 */

const SYLLABLES_S = [0.22, 0.31, 0.18, 0.27, 0.35, 0.2, 0.25];
const PAUSES_S = [0.08, 0.12, 0.06, 0.1];

/** A 16-bit mono WAV of `seconds` of speech-like sound at `rate` Hz. */
export function speechWav(seconds = 5, rate = 48000): Buffer {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  // Syllable k: start, end and base pitch.
  const syllables: Array<{ start: number; end: number; pitch: number }> = [];
  for (let t = 0, k = 0; t < seconds; k++) {
    const length = SYLLABLES_S[k % SYLLABLES_S.length]!;
    syllables.push({ start: t, end: t + length, pitch: 110 + ((k * 37) % 90) });
    t += length + PAUSES_S[k % PAUSES_S.length]!;
  }
  let phase = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    while (k < syllables.length && t >= syllables[k]!.end) k++;
    const s = syllables[k];
    let v = 0;
    if (s && t >= s.start) {
      const x = (t - s.start) / (s.end - s.start);
      // The pitch rises by a quarter over the syllable; the envelope opens and closes softly.
      phase += (2 * Math.PI * s.pitch * (1 + 0.25 * x)) / rate;
      for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
      v *= 0.3 * Math.sqrt(Math.sin(Math.PI * x));
    }
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  return buf;
}
