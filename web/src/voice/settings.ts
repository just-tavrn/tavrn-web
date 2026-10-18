// SPDX-License-Identifier: Apache-2.0
/**
 * Voice & video settings (design note 4.9): kept per device in localStorage and applied live to a running
 * call. Pure helpers (validation, constraints, limits) are exported for the session and the settings tab.
 */
import { create } from "zustand";
import { platform, type HotkeyAction } from "../platform";
import { browserOs } from "./screenAudio";

export type NoiseSuppression = "off" | "browser" | "rnnoise";
export type InputMode = "vad" | "ptt";
export type BackgroundMode = "none" | "blur" | "image";
/** Segmentation quality of background effects (`background.ts`). */
export type BackgroundQuality = "fast" | "balanced" | "high";
export type Resolution = "360p" | "720p" | "1080p" | "1440p" | "4k";
/** A phone's front (`user`) or back (`environment`) camera (`facingMode`). */
export type CameraFacing = "user" | "environment";

/** Notification sounds (`cues.ts`). */
export const CUE_NAMES = ["join", "leave", "mute", "unmute", "deafen", "undeafen", "stream_on", "stream_off", "connection_lost", "connection_restored", "ptt_on", "ptt_off", "priority_on", "priority_off", "muted_talk", "whisper_start", "whisper_end"] as const;
export type Cue = (typeof CUE_NAMES)[number];

/**
 * One binding per hotkey action (`voice/hotkeys.ts`, issue #36): it works in the window and, in the desktop app,
 * system-wide. `""` = none. The shell's canonical spelling: `Ctrl+Alt+Shift+Super+<KeyboardEvent.code>`, a key alone
 * as its code (`KeyV`, `F13`), a modifier alone as its own code (`ControlLeft`).
 */
export type Hotkeys = Record<"push_to_talk" | "priority" | "toggle_mute" | "toggle_deafen", string> & Partial<Record<"whisper_reply" | `whisper:${string}`, string>>;

/** Only bounded voice action names cross the desktop bridge. */
export const validHotkeyAction = (a: string): a is HotkeyAction => ["push_to_talk", "priority", "toggle_mute", "toggle_deafen", "whisper_reply"].includes(a) || /^whisper:[A-Za-z0-9_-]{1,64}$/.test(a);


export interface WhisperGroup { id: string; name: string; members: string[] }
export const whisperRoomKey = (domain: string, roomId: string) => `${domain}/${roomId}`;

export interface VoiceSettings {
  whisperGroups: Record<string, WhisperGroup[]>;
  /** Empty = the system default device. */
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  /** Phones and tablets without a chosen camera: the front or the back one (the camera button's menu). */
  cameraFacing: CameraFacing;
  /** Percent, 0–200. */
  inputVolume: number;
  outputVolume: number;
  autoGain: boolean;
  echoCancellation: boolean;
  noiseSuppression: NoiseSuppression;
  inputMode: InputMode;
  /** Voice activation threshold in dBFS (-100–0). */
  vadThreshold: number;
  /** Push-to-talk stays open this long after the key is released (ms). */
  pttReleaseMs: number;
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
  /** Push-to-talk, priority speaker (held), mute and deafen (toggles): one binding each, window and system-wide. */
  hotkeys: Hotkeys;
  /**
   * A soft cue and a pulsing microphone button when the user talks while muted (`mutedTalk.ts`, issue #125). The default
   * depends on the platform ({@link mutedTalkHintDefault}); only a choice that differs from it is stored.
   */
  mutedTalkHint: boolean;
  /** Keep the screen on while in a voice channel or call (Screen Wake Lock, `wakeLock.ts`; browsers: visible page only). */
  keepScreenOn: boolean;
  /** Desktop app on Windows: voice through the shell's native engine (`engine.ts`; Linux always uses it). */
  nativeEngine: boolean;
  /** The native engine's microphone and speakers (its own device ids; empty = the system default). */
  nativeInputDeviceId: string;
  nativeOutputDeviceId: string;
}

/** The defaults outside Android; {@link defaultSettings} has this device's (the talking-while-muted hint differs). */
export const DEFAULT_SETTINGS: VoiceSettings = {
  whisperGroups: {},
  inputDeviceId: "",
  outputDeviceId: "",
  cameraDeviceId: "",
  cameraFacing: "user",
  inputVolume: 100,
  outputVolume: 100,
  autoGain: true,
  echoCancellation: true,
  noiseSuppression: "browser",
  inputMode: "vad",
  vadThreshold: -55,
  pttReleaseMs: 250,
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
  hotkeys: { push_to_talk: "Backquote", priority: "", toggle_mute: "", toggle_deafen: "" },
  mutedTalkHint: true,
  keepScreenOn: true,
  nativeEngine: false,
  nativeInputDeviceId: "",
  nativeOutputDeviceId: "",
};

/**
 * The browser on Android or the Android app (the same engine): the platform layer knows the app once it started, the
 * user agent says Android for both from the first line on (the settings load before the platform is detected).
 */
function onAndroid(): boolean {
  const p = platform();
  if (p.kind === "android" || p.shell?.os === "android") return true;
  return typeof navigator !== "undefined" && browserOs(navigator.userAgent) === "android";
}

/**
 * The talking-while-muted hint keeps the capture open while muted; on Android that holds the device in its call audio
 * mode, so the hint is off there unless the user turns it on (issue #147).
 */
export function mutedTalkHintDefault(): boolean {
  return !onAndroid();
}

/** The defaults of this device. */
export function defaultSettings(): VoiceSettings {
  return { ...DEFAULT_SETTINGS, mutedTalkHint: mutedTalkHintDefault() };
}

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

/** Modifiers in the fixed order and one `KeyboardEvent.code`; the shell validates the key itself. */
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Super\+)?[A-Za-z][A-Za-z0-9]{0,23}$/;

/** A binding in the canonical spelling, or `""`. */
function binding(v: unknown): string {
  if (typeof v !== "string" || v.length > 64 || !COMBO.test(v)) return "";
  return v.replace(/(^|\+)OS(Left|Right)$/, "$1Meta$2");
}

/**
 * The bindings; settings stored before issue #36 kept the keys of the window (`pttKey`, `priorityKey`) apart from the
 * desktop app's global hotkeys (`desktopHotkeys`): the window's key is the binding now, a global binding fills in where
 * the window had none (push-to-talk: the untouched default), mute and deafen come from the global ones.
 */
function hotkeys(r: Record<string, unknown>): Hotkeys {
  const out = { ...DEFAULT_SETTINGS.hotkeys };
  if (r.hotkeys && typeof r.hotkeys === "object") {
    const h = r.hotkeys as Record<string, unknown>;
    for (const a of Object.keys(h).filter(validHotkeyAction).slice(0, 128)) out[a] = binding(h[a]);
  } else {
    const legacy = r.desktopHotkeys && typeof r.desktopHotkeys === "object" ? (r.desktopHotkeys as Record<string, unknown>) : {};
    const global = (a: HotkeyAction) => binding(legacy[a]);
    const ptt = binding(r.pttKey) || DEFAULT_SETTINGS.hotkeys.push_to_talk;
    out.push_to_talk = ptt === DEFAULT_SETTINGS.hotkeys.push_to_talk && global("push_to_talk") ? global("push_to_talk") : ptt;
    out.priority = binding(r.priorityKey) || global("priority");
    out.toggle_mute = global("toggle_mute");
    out.toggle_deafen = global("toggle_deafen");
  }
  // Never one binding for two actions.
  const seen = new Set<string>();
  for (const a of Object.keys(out) as HotkeyAction[]) {
    if (out[a] && seen.has(out[a])) out[a] = "";
    else if (out[a]) seen.add(out[a]);
  }
  return out;
}

/** Validates stored or edited settings; anything unknown falls back to the default. */
export function normalizeSettings(raw: unknown): VoiceSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = defaultSettings();
  const image = typeof r.backgroundImage === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(r.backgroundImage) ? r.backgroundImage : null;
  let background = oneOf(r.background, ["none", "blur", "image"] as const, d.background);
  if (background === "image" && !image) background = "none";
  return {
    inputDeviceId: str(r.inputDeviceId, d.inputDeviceId),
    outputDeviceId: str(r.outputDeviceId, d.outputDeviceId),
    cameraDeviceId: str(r.cameraDeviceId, d.cameraDeviceId),
    cameraFacing: oneOf(r.cameraFacing, ["user", "environment"] as const, d.cameraFacing),
    inputVolume: num(r.inputVolume, d.inputVolume, 0, 200),
    outputVolume: num(r.outputVolume, d.outputVolume, 0, 200),
    autoGain: bool(r.autoGain, d.autoGain),
    echoCancellation: bool(r.echoCancellation, d.echoCancellation),
    noiseSuppression: oneOf(r.noiseSuppression, ["off", "browser", "rnnoise"] as const, d.noiseSuppression),
    inputMode: oneOf(r.inputMode, ["vad", "ptt"] as const, d.inputMode),
    vadThreshold: num(r.vadThreshold, d.vadThreshold, -100, 0),
    pttReleaseMs: num(r.pttReleaseMs, d.pttReleaseMs, 0, 2000),
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
    hotkeys: hotkeys(r),
    whisperGroups: normalizeWhisperGroups(r.whisperGroups),
    mutedTalkHint: bool(r.mutedTalkHint, d.mutedTalkHint),
    keepScreenOn: bool(r.keepScreenOn, d.keepScreenOn),
    nativeEngine: bool(r.nativeEngine, d.nativeEngine),
    nativeInputDeviceId: str(r.nativeInputDeviceId, d.nativeInputDeviceId, 512),
    nativeOutputDeviceId: str(r.nativeOutputDeviceId, d.nativeOutputDeviceId, 512),
  };
}

function load(): VoiceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSettings();
  }
}

/** The talking-while-muted hint only as a choice that differs from the platform's default, so the default can follow it. */
function save(settings: VoiceSettings): void {
  try {
    const { mutedTalkHint, ...rest } = settings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(mutedTalkHint === mutedTalkHintDefault() ? rest : settings));
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

/**
 * Camera capture options within the node's limits (VOICE.md §4). `phone`: the front or back camera when no camera was
 * chosen by id; desktops never name a facing (an integrated camera reporting `user` would win over the system's default).
 */
export function cameraOptions(s: VoiceSettings, limit: { max_resolution: string; max_fps: number }, phone = false): { deviceId?: string; facingMode?: CameraFacing; width: number; height: number; frameRate: number } {
  const size = resolutionSize(limitResolution(s.cameraResolution, limit.max_resolution));
  const pick = s.cameraDeviceId ? { deviceId: s.cameraDeviceId } : phone ? { facingMode: s.cameraFacing } : {};
  return { ...pick, ...size, frameRate: Math.min(s.cameraFps, limit.max_fps || 30) };
}

/** Phones and tablets (touch first, or the Android app): their cameras are "front" and "back", not a device list. */
export function phoneCameras(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}


function normalizeWhisperGroups(raw: unknown): Record<string, WhisperGroup[]> {
  const out: Record<string, WhisperGroup[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [room, groups] of Object.entries(raw).slice(0, 128)) {
    if (room.length > 512 || !/^[^\s/]+\/[^\s/]+$/.test(room) || !Array.isArray(groups)) continue;
    const seen = new Set<string>();
    out[room] = groups.slice(0, 32).flatMap((g) => {
      if (!g || typeof g !== "object" || typeof g.id !== "string" || !validHotkeyAction(`whisper:${g.id}`) || seen.has(g.id) || typeof g.name !== "string" || !g.name.trim() || !Array.isArray(g.members)) return [];
      seen.add(g.id);
      return [{ id: g.id, name: g.name.trim().slice(0, 64), members: [...new Set<string>(g.members.filter((m: unknown): m is string => typeof m === "string" && m.length <= 320 && /^[^\s/@]+@[^\s/]+$/.test(m)))] }];
    });
  }
  return out;
}
