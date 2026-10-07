// SPDX-License-Identifier: Apache-2.0
/**
 * Soundboard clips before upload (VOICE.md §8): the node cannot decode audio, so the client declares the
 * duration and trims clips longer than five seconds (or larger than 1 MiB) by re-encoding the first five
 * seconds as 16-bit mono WAV (at most ~470 KB at 48 kHz).
 */
export const MAX_CLIP_MS = 5000;
export const MAX_CLIP_BYTES = 1024 * 1024;

/** 16-bit PCM WAV of the first `maxSeconds`, channels mixed down to mono. */
export function encodeWav(channels: Float32Array[], sampleRate: number, maxSeconds = MAX_CLIP_MS / 1000): Uint8Array {
  const frames = Math.min(channels[0]?.length ?? 0, Math.floor(sampleRate * maxSeconds));
  const data = frames * 2;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i] ?? 0;
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, channels.length)));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out;
}

export interface PreparedClip {
  blob: Blob;
  durationMs: number;
  trimmed: boolean;
}

/** Decodes a picked audio file; trims and re-encodes it when it is too long or too large. */
export async function prepareClip(file: File): Promise<PreparedClip> {
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const durationMs = Math.round(buffer.duration * 1000);
    if (durationMs <= MAX_CLIP_MS && file.size <= MAX_CLIP_BYTES) return { blob: file, durationMs: Math.max(1, durationMs), trimmed: false };
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const wav = encodeWav(channels, buffer.sampleRate);
    return { blob: new Blob([wav.slice().buffer], { type: "audio/wav" }), durationMs: Math.min(durationMs, MAX_CLIP_MS), trimmed: durationMs > MAX_CLIP_MS };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
