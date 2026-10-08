// SPDX-License-Identifier: Apache-2.0
/**
 * Voice & video settings (design note 4.9): kept per device in localStorage and applied live to a running
 * call. Pure helpers (validation, constraints, limits) are exported for the session and the settings tab.
 */
import { create } from "zustand";

export type NoiseSuppression = "off" | "browser" | "rnnoise";
export type InputMode = "vad" | "ptt";
export type BackgroundMode = "none" | "blur" | "image";
/** Segmentation quality of background effects (`background.ts`). */
export type BackgroundQuality = "fast" | "balanced" | "high";
export type Resolution = "360p" | "720p" | "1080p" | "1440p" | "4k";

/** Notification sounds (`cues.ts`). */
export const CUE_NAMES = ["join", "leave", "mute", "unmute", "deafen", "undeafen", "stream_on", "stream_off", "connection_lost", "connection_restored"] as const;
export type Cue = (typeof CUE_NAMES)[number];

export interface VoiceSettings {
  /** Empty = the system default device. */
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  /** Percent, 0–200. */
  inputVolume: number;
  outputVolume: number;
  autoGain: boolean;
  echoCancellation: boolean;
  noiseSuppression: NoiseSuppression;
  inputMode: InputMode;
  /** Voice activation threshold in dBFS (-100–0). */
  vadThreshold: number;
  /** `KeyboardEvent.code` of the push-to-talk key. */
  pttKey: string;
  /** Push-to-talk stays open this long after the key is released (ms). */
  pttReleaseMs: number;
  /** `KeyboardEvent.code` of the priority speaker key held while talking over others; empty = none. */
  priorityKey: string;
  noiseGate: boolean;
  /** Noise gate threshold in dBFS. */
  gateThreshold: number;
  cameraResolution: Resolution;
  cameraFps: number;
  /** Mirror the own camera preview (only locally). */
  mirror: boolean;
  background: BackgroundMode;
  /** Replacement background as a downscaled `data:image/…` URL. */
  backgroundImage: string | null;
  /** Blur strength in percent (0–100). */
  blurStrength: number;
  backgroundQuality: BackgroundQuality;
  /** Per-user playback volume of the voice (microphone) in percent (absent = 100). */
  userVolumes: Record<string, number>;
  /** Per-streamer playback volume of the screen share audio in percent (absent = 100). */
  streamVolumes: Record<string, number>;
  /** A stream the user is watching stays audible while deafened (deafen then silences voices only). */
  streamWhileDeafened: boolean;
  /** Volume of the notification sounds in percent. */
  cueVolume: number;
  /** All notification sounds off. */
  cuesOff: boolean;
  /** Notification sounds switched off one by one. */
  cuesDisabled: Cue[];
  /** Volume of the ringtone of incoming calls in percent (0 = silent, the banner still shows). */
  ringVolume: number;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  inputDeviceId: "",
  outputDeviceId: "",
  cameraDeviceId: "",
  inputVolume: 100,
  outputVolume: 100,
  autoGain: true,
  echoCancellation: true,
  noiseSuppression: "browser",
  inputMode: "vad",
  vadThreshold: -55,
  pttKey: "Backquote",
  pttReleaseMs: 250,
  priorityKey: "",
  noiseGate: false,
  gateThreshold: -65,
  cameraResolution: "720p",
  cameraFps: 30,
  mirror: true,
  background: "none",
  backgroundImage: null,
  blurStrength: 60,
  backgroundQuality: "balanced",
  userVolumes: {},
  streamVolumes: {},
  streamWhileDeafened: true,
  cueVolume: 40,
  cuesOff: false,
  cuesDisabled: [],
  ringVolume: 60,
};

export const SETTINGS_KEY = "tavrn.voice.settings";

const RESOLUTIONS: Resolution[] = ["360p", "720p", "1080p", "1440p", "4k"];
const SIZES: Record<Resolution, { width: number; height: number }> = {
  "360p": { width: 640, height: 360 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4k": { width: 3840, height: 2160 },
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), min, max) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string, max = 256) => (typeof v === "string" && v.length <= max ? v : fallback);
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Per-address volumes in percent (0–200); anything else is dropped. */
function volumeMap(raw: unknown): Record<string, number> {
  const volumes: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return volumes;
  for (const [address, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && address.length <= 320) volumes[address] = clamp(Math.round(v), 0, 200);
  }
  return volumes;
}

/** Validates stored or edited settings; anything unknown falls back to the default. */
export function normalizeSettings(raw: unknown): VoiceSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const image = typeof r.backgroundImage === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(r.backgroundImage) ? r.backgroundImage : null;
  let background = oneOf(r.background, ["none", "blur", "image"] as const, d.background);
  if (background === "image" && !image) background = "none";
  return {
    inputDeviceId: str(r.inputDeviceId, d.inputDeviceId),
    outputDeviceId: str(r.outputDeviceId, d.outputDeviceId),
    cameraDeviceId: str(r.cameraDeviceId, d.cameraDeviceId),
    inputVolume: num(r.inputVolume, d.inputVolume, 0, 200),
    outputVolume: num(r.outputVolume, d.outputVolume, 0, 200),
    autoGain: bool(r.autoGain, d.autoGain),
    echoCancellation: bool(r.echoCancellation, d.echoCancellation),
    noiseSuppression: oneOf(r.noiseSuppression, ["off", "browser", "rnnoise"] as const, d.noiseSuppression),
    inputMode: oneOf(r.inputMode, ["vad", "ptt"] as const, d.inputMode),
    vadThreshold: num(r.vadThreshold, d.vadThreshold, -100, 0),
    pttKey: str(r.pttKey, d.pttKey, 64),
    pttReleaseMs: num(r.pttReleaseMs, d.pttReleaseMs, 0, 2000),
    priorityKey: str(r.priorityKey, d.priorityKey, 64),
    noiseGate: bool(r.noiseGate, d.noiseGate),
    gateThreshold: num(r.gateThreshold, d.gateThreshold, -100, 0),
    cameraResolution: oneOf(r.cameraResolution, ["360p", "720p", "1080p"] as const, "720p"),
    cameraFps: num(r.cameraFps, d.cameraFps, 1, 60),
    mirror: bool(r.mirror, d.mirror),
    background,
    backgroundImage: image,
    blurStrength: num(r.blurStrength, d.blurStrength, 0, 100),
    backgroundQuality: oneOf(r.backgroundQuality, ["fast", "balanced", "high"] as const, d.backgroundQuality),
    userVolumes: volumeMap(r.userVolumes),
    streamVolumes: volumeMap(r.streamVolumes),
    streamWhileDeafened: bool(r.streamWhileDeafened, d.streamWhileDeafened),
    cueVolume: num(r.cueVolume, d.cueVolume, 0, 100),
    cuesOff: bool(r.cuesOff, d.cuesOff),
    cuesDisabled: Array.isArray(r.cuesDisabled) ? CUE_NAMES.filter((c) => (r.cuesDisabled as unknown[]).includes(c)) : [],
    ringVolume: num(r.ringVolume, d.ringVolume, 0, 100),
  };
}

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function save(settings: VoiceSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage full or disabled: the settings still apply to this session */
  }
}

/** A copy of `volumes` with `address` set to `percent` (100 % removes the entry). */
function withVolume(volumes: Record<string, number>, address: string, percent: number): Record<string, number> {
  const next = { ...volumes };
  if (Math.round(percent) === 100) delete next[address];
  else next[address] = percent;
  return next;
}

interface SettingsStore {
  settings: VoiceSettings;
  update: (patch: Partial<VoiceSettings>) => void;
  setUserVolume: (address: string, percent: number) => void;
  setStreamVolume: (address: string, percent: number) => void;
  reload: () => void;
}

export const useVoiceSettings = create<SettingsStore>((set, get) => ({
  settings: load(),
  update: (patch) => {
    const settings = normalizeSettings({ ...get().settings, ...patch });
    save(settings);
    set({ settings });
  },
  setUserVolume: (address, percent) => get().update({ userVolumes: withVolume(get().settings.userVolumes, address, percent) }),
  setStreamVolume: (address, percent) => get().update({ streamVolumes: withVolume(get().settings.streamVolumes, address, percent) }),
  reload: () => set({ settings: load() }),
}));

/**
 * Threshold (dBFS) of the gate in front of the microphone track, or null for "always open": voice
 * activation opens at its threshold; the noise gate adds a floor (in push-to-talk mode it is the only one).
 */
export function gateThreshold(s: VoiceSettings): number | null {
  const gate = s.noiseGate ? s.gateThreshold : null;
  if (s.inputMode === "vad") return gate === null ? s.vadThreshold : Math.max(s.vadThreshold, gate);
  return gate;
}

/** `getUserMedia` audio constraints for the settings. */
export function captureConstraints(s: VoiceSettings): MediaTrackConstraints {
  return {
    ...(s.inputDeviceId ? { deviceId: { exact: s.inputDeviceId } } : {}),
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGain,
    noiseSuppression: s.noiseSuppression === "browser",
    channelCount: 1,
    sampleRate: 48000,
  };
}

/** The wanted resolution, lowered to the node's maximum (unknown maximum: unchanged). */
export function limitResolution(wanted: Resolution, max: string): Resolution {
  const m = RESOLUTIONS.indexOf(max as Resolution);
  if (m < 0) return wanted;
  return RESOLUTIONS.indexOf(wanted) > m ? RESOLUTIONS[m]! : wanted;
}

export function resolutionSize(r: Resolution | string): { width: number; height: number } {
  return SIZES[r as Resolution] ?? SIZES["720p"];
}

/** Camera capture options within the node's limits (VOICE.md §4). */
export function cameraOptions(s: VoiceSettings, limit: { max_resolution: string; max_fps: number }): { deviceId?: string; width: number; height: number; frameRate: number } {
  const size = resolutionSize(limitResolution(s.cameraResolution, limit.max_resolution));
  return { ...(s.cameraDeviceId ? { deviceId: s.cameraDeviceId } : {}), ...size, frameRate: Math.min(s.cameraFps, limit.max_fps || 30) };
}
