// SPDX-License-Identifier: Apache-2.0
/**
 * Voice channel quality (VOICE.md §4a, client conventions): the presets for a channel's `bitrate_kbps`,
 * music mode, and what the microphone captures and publishes for them. Opus is the only audio codec; with an
 * SFU every listener receives what a speaker publishes, so quality is a channel setting.
 */
import { captureConstraints, type VoiceSettings } from "./settings";

export type PresetId = "saver" | "standard" | "high" | "studio" | "music";

export interface Preset {
  id: PresetId;
  kbps: number;
  /** Music mode: stereo Opus, no microphone processing. */
  stereo: boolean;
}

export const MIN_KBPS = 8;
export const MAX_KBPS = 512;
/** Default of new channels (the node's, too). */
export const DEFAULT_KBPS = 64;
/** Music mode applies from this bitrate on. */
export const MUSIC_KBPS = 192;

export const PRESETS: readonly Preset[] = [
  { id: "saver", kbps: 8, stereo: false },
  { id: "standard", kbps: 32, stereo: false },
  { id: "high", kbps: 64, stereo: false },
  { id: "studio", kbps: 128, stereo: false },
  { id: "music", kbps: MUSIC_KBPS, stereo: true },
];

/** The preset of a bitrate; any other value is "custom". */
export function presetOf(kbps: number): PresetId | "custom" {
  return PRESETS.find((p) => p.kbps === kbps)?.id ?? "custom";
}

/** Music mode: the Music preset and larger custom values. */
export function isMusic(kbps: number): boolean {
  return kbps >= MUSIC_KBPS;
}

/** The presets with `limited` for those above the node's cap (`node.voice.max_bitrate_kbps`; null: unknown). */
export function presetChoices(cap: number | null): Array<Preset & { limited: boolean }> {
  return PRESETS.map((p) => ({ ...p, limited: cap !== null && p.kbps > cap }));
}

/** A custom value as the node accepts it: a whole number within 8 … cap. */
export function clampCustom(value: number, cap: number | null): number {
  if (!Number.isFinite(value)) return DEFAULT_KBPS;
  return Math.min(cap ?? MAX_KBPS, MAX_KBPS, Math.max(MIN_KBPS, Math.round(value)));
}

/** Megabytes per hour for one speaker and one listener (the upper bound: DTX sends almost nothing in silence). */
export function trafficMbPerHour(kbps: number): number {
  return Math.round((kbps * 3600) / 8 / 1000);
}

/**
 * `getUserMedia` constraints: the user's settings for speech; in music mode echo cancellation, noise
 * suppression and auto gain off and two channels if the device has them (`ideal`, never required).
 */
export function captureFor(settings: VoiceSettings, music: boolean): MediaTrackConstraints {
  const base = captureConstraints(settings);
  if (!music) return base;
  return { ...base, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
}

/**
 * Stereo only in music mode and only when the captured track reports two channels; anything else is a mono
 * capture, published as mono (heard in the middle, never on one side only).
 */
export function stereoCapture(music: boolean, captured: MediaTrackSettings | undefined): boolean {
  return music && captured?.channelCount === 2;
}

/**
 * LiveKit publish options of the microphone: the channel's bitrate, RED off (end-to-end encryption), DTX on
 * for speech and off for music (it would cut quiet passages), stereo Opus only for a stereo capture. Opus
 * in-band FEC needs no option: the SFU's answer negotiates it (`limits.audio_fec`) and the browser's
 * encoder follows it.
 */
export function micPublishOptions(kbps: number, mode: { music: boolean; stereo: boolean }) {
  return {
    audioPreset: { maxBitrate: kbps * 1000 },
    dtx: !mode.music,
    red: false,
    forceStereo: mode.music && mode.stereo,
    stopMicTrackOnMute: false,
  };
}
