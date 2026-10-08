// SPDX-License-Identifier: Apache-2.0
/// <reference types="vite/client" />
/**
 * The voice session of this device (VOICE.md §4, ENCRYPTION.md §5a): joins the channel's MLS group and
 * commits a self update, gets a LiveKit token from the room's node, hands the frame key of the current
 * epoch to LiveKit's key provider, connects with end-to-end encryption and only then publishes. Every
 * epoch change of the group re-keys the call. Loaded lazily on the first join (`index.ts`), so the text
 * client never loads LiveKit.
 *
 * Security rules: nothing is published before the key provider holds a key and LiveKit confirmed that
 * encryption is enabled for this device; there is no unencrypted fallback (without insertable streams
 * joining fails with a blocking warning).
 *
 * Remote audio plays through LiveKit's Web Audio mix on an AudioContext of this session. Every remote
 * audio track gets two pass-through nodes in front of LiveKit's volume gain (`setWebAudioPlugins`): an
 * `AnalyserNode` for the speaking ring (microphones only, `speaking.ts`) and a ducking gain for the
 * priority speaker (`priority.ts`). Both sit behind the decryption (insertable streams work on encoded
 * frames, the nodes see decoded audio) and before the per-user volume, which multiplies with the ducking.
 */
import { cleanupConversation } from "../lib/leafCleanup";
import {
  ConnectionQuality,
  DisconnectReason,
  LocalVideoTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  isE2EESupported,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import type { Sound, TavrnApi, VoiceJoin, VoiceParticipant, VoiceStatePatch } from "@tavrn/sdk";
import { apiFor } from "../stores/nodes";
import { getMls, useMlsUi } from "../stores/mls";
import { qualify, splitIdentity, type MlsManager } from "@tavrn/e2ee";
import { useToasts } from "../stores/toasts";
import { t } from "../i18n";
import { MicPipeline } from "./audio";
import { markWeakDevice } from "./frames";
import { TavrnKeyProvider } from "./keyProvider";
import { VoiceError, voiceErrorMessage } from "./errors";
import { channelKey, participantsOf, useVoicePresence } from "./presence";
import { cameraOptions, resolutionSize, useVoiceSettings, type VoiceSettings } from "./settings";
import { withEntitlementCaps } from "./entitlementCaps";
import { IDLE, SpeakingBatcher, isWatched, useSoundOverlays, useVoice, useWatchedStreams, type ParticipantMedia, type Quality, type VoiceTarget } from "./store";
import { participantVolumes, type Volumes } from "./volume";
import { ANALYSER_SIZE, SPEAKING_POLL_MS, SpeakingDetector, analysersAvailable, combineLevels, localLevel, rmsDb } from "./speaking";
import { PriorityTracker, claimsPriority, duckGain, rampTo, verifyPriority } from "./priority";
import { SOUND_TOPIC, SignalLimiter, encodeSoundSignal, parseClipEmoji, parseSoundSignal } from "./soundSignal";
import { throttledActivity } from "../lib/idle";
import type { LevelReport } from "./audio";
import { DEFAULT_GRACE_MS, RejoinSchedule } from "./reconnect";
import { playCue, type Cue } from "./cues";
import { setIcePolicy } from "./ice";
import { desktopHeld } from "./hotkeys";
import type { BackgroundHandle } from "./background";

/** LiveKit must confirm encryption for this device within this time, else nothing is published. */
const E2EE_CONFIRM_MS = 10_000;
/** After a removal by a moderator, a `voice.move` may follow: wait this long before giving up. */
const MOVE_GRACE_MS = 2_000;

/** What the session needs from a voice channel join or a call join (`VoiceJoin`, `CallJoin`). */
type JoinInfo = Pick<VoiceJoin, "url" | "token" | "epoch" | "limits" | "reconnect_grace_secs" | "participants"> & { ice_aliases?: string[] };

/** The node routes of the target: a voice channel or a call (VOICE.md §3, §11). */
interface Endpoints {
  join: (start: boolean) => Promise<JoinInfo>;
  leave: () => Promise<unknown>;
  updateState: (patch: VoiceStatePatch) => Promise<unknown>;
}

function endpoints(api: TavrnApi, target: VoiceTarget): Endpoints {
  if (target.call) {
    const id = target.channelId;
    return { join: (start) => (start ? api.calls.start(id) : api.calls.join(id)), leave: () => api.calls.leave(id), updateState: (patch) => api.calls.updateState(id, patch) };
  }
  return {
    join: () => api.voice.join(target.roomId, target.channelId),
    leave: () => api.voice.leave(target.roomId, target.channelId),
    updateState: (patch) => api.voice.updateState(target.roomId, target.channelId, patch),
  };
}

interface Session {
  id: number;
  target: VoiceTarget;
  q: string;
  api: TavrnApi;
  ep: Endpoints;
  mls: MlsManager;
  room: Room;
  pipeline: MicPipeline;
  keyProvider: TavrnKeyProvider;
  info: JoinInfo;
  offs: Array<() => void>;
  leaving: boolean;
  /** Mute state to restore when undeafening. */
  mutedBeforeDeafen: boolean;
  clips: Map<string, Promise<AudioBuffer>>;
  background: BackgroundHandle | null;
  /** Playback context of the remote audio (LiveKit's Web Audio mix); null without Web Audio. */
  audio: AudioContext | null;
  /** Analyser and ducking nodes per remote audio track. */
  taps: Map<RemoteAudioTrack, Tap>;
  /** Remote speakers from the analysers (null: LiveKit's active speakers are used). */
  detector: SpeakingDetector | null;
  /** Remote speakers as LiveKit reports them (fallback). */
  lkSpeakers: Record<string, number>;
  /** Verified priority speakers (ducking). */
  priority: PriorityTracker;
  /** Rate limit of soundboard signals (own and per sender). */
  signals: SignalLimiter;
}

interface Tap {
  identity: string;
  analyser: AnalyserNode | null;
  duck: GainNode;
}

let current: Session | null = null;
/** The channel a moderator just removed this device from (a `voice.move` may follow, `followMove`). */
let removed: { target: VoiceTarget; at: number } | null = null;
let nextId = 1;
let pending: Promise<void> | null = null;
const batcher = new SpeakingBatcher(100);
/** The gate's last report (own speaking ring, design note 4.13 item 3). */
let lastReport: LevelReport = { level: Number.NEGATIVE_INFINITY, open: false };
/** Transmitting counts as activity for the idle detection, at most once per 30 s. */
const talking = throttledActivity(30_000);
/** Timers of the soundboard overlays. */
const overlayTimers = new Map<string, ReturnType<typeof setTimeout>>();
const analyserBuffer = new Float32Array(ANALYSER_SIZE);

const set = (patch: Partial<ReturnType<typeof useVoice.getState>>) => useVoice.setState(patch);
/** A notification sound (design note 4.9); `own` = about this user (plays while deafened too). */
const cue = (c: Cue, own: boolean) => playCue(c, { own, deafened: useVoice.getState().deafened });
const settings = () => useVoiceSettings.getState().settings;
const sameTarget = (a: VoiceTarget | null, b: VoiceTarget) => !!a && a.domain === b.domain && a.roomId === b.roomId && a.channelId === b.channelId && !!a.call === !!b.call;

function canPublish(room: Room, source: Track.Source): boolean {
  const p = room.localParticipant.permissions;
  if (!p?.canPublish) return false;
  return p.canPublishSources.length === 0 || p.canPublishSources.map((s) => Track.sourceFromProto(s)).includes(source);
}

/** Waits until LiveKit's worker confirmed encryption for the local participant. */
function confirmE2ee(room: Room): Promise<void> {
  if (room.isE2EEEnabled) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      room.off(RoomEvent.ParticipantEncryptionStatusChanged, on);
      reject(new VoiceError("e2ee_failed"));
    }, E2EE_CONFIRM_MS);
    const on = (enabled: boolean, participant?: Participant) => {
      if (participant !== room.localParticipant || !enabled) return;
      clearTimeout(timer);
      room.off(RoomEvent.ParticipantEncryptionStatusChanged, on);
      resolve();
    };
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, on);
  });
}

function qualityOf(q: ConnectionQuality): Quality {
  switch (q) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
}

function mediaOf(p: Participant): ParticipantMedia {
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  return {
    camera: !!cam?.track && !cam.isMuted,
    screen: !!p.getTrackPublication(Track.Source.ScreenShare)?.track,
    micMuted: !mic || mic.isMuted,
    screenAudio: !!p.getTrackPublication(Track.Source.ScreenShareAudio)?.track,
  };
}

/** Hidden container of the remote audio elements (LiveKit plays remote audio only through attached elements). */
function audioSink(): HTMLElement {
  let el = document.getElementById("tavrn-voice-audio");
  if (!el) {
    el = document.createElement("div");
    el.id = "tavrn-voice-audio";
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function playAudio(s: Session, track: RemoteTrack, source: Track.Source, identity: string) {
  if (track.kind !== Track.Kind.Audio) return;
  if (track instanceof RemoteAudioTrack) tap(s, track, source, identity);
  const el = track.attach();
  audioSink().appendChild(el);
}

function stopAudio(s: Session, track: RemoteTrack) {
  if (track.kind !== Track.Kind.Audio) return;
  if (track instanceof RemoteAudioTrack) untap(s, track);
  track.detach().forEach((el) => el.remove());
}

/**
 * Puts the analyser (microphones, when the analyser path runs) and the ducking gain in front of LiveKit's
 * volume gain of a remote audio track. Pass-through nodes: the audio is unchanged except for the ducking.
 */
function tap(s: Session, track: RemoteAudioTrack, source: Track.Source, identity: string) {
  const ctx = s.audio;
  if (!ctx || s.taps.has(track)) return;
  try {
    const duck = ctx.createGain();
    duck.gain.value = duckGain(identity, s.priority.active);
    let analyser: AnalyserNode | null = null;
    if (s.detector && source === Track.Source.Microphone) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_SIZE;
      analyser.smoothingTimeConstant = 0;
    }
    s.taps.set(track, { identity, analyser, duck });
    track.setWebAudioPlugins(analyser ? [analyser, duck] : [duck]);
  } catch (e) {
    console.warn("voice: audio tap failed", e);
  }
}

function untap(s: Session, track: RemoteAudioTrack) {
  const t = s.taps.get(track);
  if (!t) return;
  s.taps.delete(track);
  t.analyser?.disconnect();
  t.duck.disconnect();
  if (t.analyser && ![...s.taps.values()].some((x) => x.identity === t.identity && x.analyser)) s.detector?.forget(t.identity);
}

/** Whether the analysers decide about remote speakers right now (else LiveKit's active speakers). */
function analysing(s: Session): boolean {
  return !!s.detector && s.audio?.state === "running" && !document.documentElement.dataset.weakDevice;
}

/** Writes the complete set of speakers: the own level from the gate, the others from analysers or LiveKit. */
function emitSpeakers(s: Session, now = performance.now()) {
  if (current !== s) return;
  const state = useVoice.getState();
  const own = localLevel(lastReport, state.muted || !state.canSpeak);
  const remote = analysing(s) ? s.detector!.levels(now) : s.lkSpeakers;
  batcher.speakers(combineLevels({ identity: s.room.localParticipant.identity || null, level: own }, remote));
}

/** The one 50 ms loop over every analyser (no timer per track). */
function startSpeakingLoop(s: Session) {
  if (!s.detector) return;
  const timer = setInterval(() => {
    if (current !== s) return;
    if (analysing(s)) {
      const now = performance.now();
      for (const t of s.taps.values()) {
        if (!t.analyser) continue;
        t.analyser.getFloatTimeDomainData(analyserBuffer);
        s.detector!.push(t.identity, rmsDb(analyserBuffer), now);
      }
    }
    emitSpeakers(s);
  }, SPEAKING_POLL_MS);
  s.offs.push(() => clearInterval(timer));
}

/** The gate's report (about ten times per second, at once when it opens or closes). */
function onLevel(r: LevelReport) {
  lastReport = r;
  const state = useVoice.getState();
  if (state.transmitting !== r.open) set({ transmitting: r.open });
  const s = current;
  if (!s) return;
  if (r.open && !state.muted && state.canSpeak) talking();
  emitSpeakers(s);
}

// ---------------------------------------------------------------- priority speaker (design note 4.13 item 3)

/** Ramps every remote track to its ducking gain and publishes who is a priority speaker. */
function applyDucking(s: Session, active: ReadonlySet<string>) {
  if (current !== s) return;
  const ctx = s.audio;
  if (ctx) for (const t of s.taps.values()) rampTo(t.duck.gain, duckGain(t.identity, active), ctx.currentTime);
  publishPriority(s);
}

function publishPriority(s: Session) {
  const priority: Record<string, true> = {};
  for (const id of s.priority.active) priority[id] = true;
  if (useVoice.getState().prioritySelf) priority[s.room.localParticipant.identity] = true;
  set({ priority });
}

function followPriorityClaim(s: Session, p: Participant) {
  if (current !== s || p === s.room.localParticipant) return;
  void s.priority.update(p.identity, claimsPriority(p.attributes));
}

// ---------------------------------------------------------------- soundboard signal (design note 4.13 item 3)

function showSoundOverlay(identity: string, emoji: string | undefined, durationMs: number) {
  if (!emoji || !parseClipEmoji(emoji)) return;
  const key = Date.now() + Math.random();
  useSoundOverlays.setState((st) => ({ overlays: { ...st.overlays, [identity]: { emoji, key } } }));
  clearTimeout(overlayTimers.get(identity));
  overlayTimers.set(
    identity,
    setTimeout(() => {
      overlayTimers.delete(identity);
      useSoundOverlays.setState((st) => {
        if (st.overlays[identity]?.key !== key) return st;
        const overlays = { ...st.overlays };
        delete overlays[identity];
        return { overlays };
      });
    }, durationMs),
  );
}

function clearSoundOverlays() {
  overlayTimers.forEach((t) => clearTimeout(t));
  overlayTimers.clear();
  useSoundOverlays.setState({ overlays: {} });
}

function refreshMedia(s: Session) {
  if (current !== s) return;
  const media: Record<string, ParticipantMedia> = { [s.room.localParticipant.identity]: mediaOf(s.room.localParticipant) };
  for (const p of s.room.remoteParticipants.values()) media[p.identity] = mediaOf(p);
  const local = media[s.room.localParticipant.identity]!;
  const focus = useVoice.getState().focus;
  set({ media, camera: local.camera, screen: local.screen, focus: focus && media[focus]?.screen ? focus : null });
}

/** The volumes last applied per identity (development test hooks). */
const applied = new Map<string, Volumes>();

/**
 * Playback volumes of a remote participant (`volume.ts`, issue #20): the voice volume on the microphone, the
 * stream volume on the screen share audio, both times the output volume; deafen silences the voice, and the
 * stream too unless it is watched (and "stream audio while deafened" is on).
 */
function applyVolume(p: RemoteParticipant, deafened = useVoice.getState().deafened) {
  const v = participantVolumes(settings(), splitIdentity(p.identity).address, { deafened, watched: isWatched(useWatchedStreams.getState(), p.identity) });
  p.setVolume(v.microphone, Track.Source.Microphone);
  p.setVolume(v.stream, Track.Source.ScreenShareAudio);
  applied.set(p.identity, v);
}

function applyVolumes(s: Session) {
  for (const p of s.room.remoteParticipants.values()) applyVolume(p);
}

async function reportState(s: Session, patch: { muted?: boolean; deafened?: boolean; streaming?: boolean; camera?: boolean }) {
  try {
    await s.ep.updateState(patch);
  } catch (e) {
    // 409 voice.not_connected right after joining (the reservation expired) is harmless.
    if ((e as { code?: string }).code !== "voice.not_connected") useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

/** Re-keys after an epoch change of the channel's group (ENCRYPTION.md §5a). */
async function rekey(s: Session) {
  if (current !== s) return;
  const vk = s.mls.voiceKey(s.q);
  if (!vk) return;
  try {
    await s.keyProvider.setEpochKey(vk.key, vk.epoch);
  } finally {
    vk.key.fill(0);
  }
}

async function publishMic(s: Session) {
  if (!canPublish(s.room, Track.Source.Microphone) || s.room.localParticipant.getTrackPublication(Track.Source.Microphone)) return;
  // Never publish before encryption is confirmed for this device (VOICE.md §6).
  if (!s.room.isE2EEEnabled || !s.room.localParticipant.isE2EEEnabled) throw new VoiceError("e2ee_failed");
  const pub = await s.room.localParticipant.publishTrack(s.pipeline.track, {
    source: Track.Source.Microphone,
    audioPreset: { maxBitrate: s.info.limits.audio_bitrate_kbps * 1000 },
    dtx: true,
    red: false,
    stopMicTrackOnMute: false,
  });
  if (useVoice.getState().muted) {
    await pub.mute();
    await s.pipeline.setPaused(true);
  }
}

function onPermissions(s: Session) {
  // The node revokes the microphone grant on a server mute (VOICE.md §7) and restores it on unmute; the
  // self mute stays the user's (a server mute leaves the user muted).
  const canSpeak = canPublish(s.room, Track.Source.Microphone);
  set(canSpeak ? { canSpeak, serverMuted: false } : { canSpeak, serverMuted: true, muted: true });
  emitSpeakers(s);
  if (canSpeak) void publishMic(s).catch(() => undefined);
}

/** A participant that left or came back starts without a (possibly "lost") quality. */
function forgetQuality(identity: string) {
  if (!(identity in useVoice.getState().qualities)) return;
  useVoice.setState((st) => {
    const qualities = { ...st.qualities };
    delete qualities[identity];
    return { qualities };
  });
}

function wire(s: Session) {
  const { room } = s;
  const media = () => refreshMedia(s);
  room
    .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      // Fallback of the analysers (and always for the own device: that ring follows the gate).
      if (current !== s) return;
      s.lkSpeakers = Object.fromEntries(speakers.filter((p) => p !== room.localParticipant).map((p) => [p.identity, p.audioLevel]));
      if (!analysing(s)) emitSpeakers(s);
    })
    .on(RoomEvent.ParticipantAttributesChanged, (_changed: Record<string, string>, p: Participant) => followPriorityClaim(s, p))
    .on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      // Signals of participants of this call, validated and limited per sender. (They are sent end-to-end
      // encrypted; livekit-client 2.22 reports decrypted packets with encryption type NONE, so the type
      // cannot be checked here. A signal only shows an emoji, nothing else.)
      if (current !== s || !p || topic !== SOUND_TOPIC) return;
      if (!s.signals.allow(p.identity, Date.now())) return;
      const signal = parseSoundSignal(payload);
      if (signal) showSoundOverlay(p.identity, signal.emoji, signal.duration_ms);
    })
    .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
      if (current !== s) return;
      const quality = qualityOf(q);
      if (p === room.localParticipant) set({ quality });
      if (useVoice.getState().qualities[p.identity] !== quality) useVoice.setState((st) => ({ qualities: { ...st.qualities, [p.identity]: quality } }));
    })
    .on(RoomEvent.Reconnecting, () => {
      if (current !== s) return;
      set({ status: "reconnecting" });
      cue("connection_lost", true);
    })
    .on(RoomEvent.Reconnected, () => {
      if (current !== s) return;
      set({ status: "connected" });
      cue("connection_restored", true);
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => void onDisconnected(s, reason))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      forgetQuality(p.identity);
      applyVolume(p);
      followPriorityClaim(s, p);
      media();
    })
    .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      forgetQuality(p.identity);
      s.priority.remove(p.identity);
      s.detector?.forget(p.identity);
      s.signals.forget(p.identity);
      applied.delete(p.identity);
      media();
    })
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: { source: Track.Source }, p: RemoteParticipant) => {
      playAudio(s, track, pub.source, p.identity);
      applyVolume(p);
      media();
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      stopAudio(s, track);
      media();
    })
    .on(RoomEvent.TrackPublished, media)
    .on(RoomEvent.TrackUnpublished, media)
    .on(RoomEvent.TrackMuted, media)
    .on(RoomEvent.TrackUnmuted, media)
    .on(RoomEvent.LocalTrackPublished, media)
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      media();
      // Stopped from the browser's own "stop sharing" bar.
      if (pub.source === Track.Source.ScreenShare && current === s && !s.leaving) void reportState(s, { streaming: false });
      if (pub.source === Track.Source.Camera && current === s && !s.leaving) void stopBackground(s);
    })
    .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p: Participant) => {
      if (p === room.localParticipant) onPermissions(s);
    })
    .on(RoomEvent.EncryptionError, (error: Error) => console.warn("voice: encryption error", error.message));
}

/** Plays the cues for changes of the other participants of the call (from `voice.state`). */
function followOthers(s: Session, key: string): () => void {
  const self = () => s.room.localParticipant.identity;
  const index = (list: VoiceParticipant[]) => new Map(list.filter((p) => p.identity !== self()).map((p) => [p.identity, p]));
  const domainLength = s.target.domain.length + 1;
  let before = index(participantsOf(useVoicePresence.getState(), s.target.domain, key.slice(domainLength)));
  return useVoicePresence.subscribe((now, prev) => {
    if (now.channels[key] === prev.channels[key] || current !== s) return;
    const after = index(participantsOf(now, s.target.domain, key.slice(domainLength)));
    for (const [id, p] of after) {
      const old = before.get(id);
      if (!old) cue("join", false);
      else if (old.connection !== p.connection) cue(p.connection === "reconnecting" ? "connection_lost" : "connection_restored", false);
      else if ((!old.streaming && p.streaming) || (!old.camera && p.camera)) cue("stream_on", false);
      else if ((old.streaming && !p.streaming) || (old.camera && !p.camera)) cue("stream_off", false);
    }
    for (const id of before.keys()) if (!after.has(id)) cue("leave", false);
    before = after;
  });
}

/** Follows changes of the MLS group, the node's epoch, the settings and push-to-talk. */
function follow(s: Session) {
  const key = channelKey(s.target.domain, s.target.channelId);
  s.offs.push(
    // Others joining, leaving, dropping or starting a stream/camera: notification sounds.
    followOthers(s, key),
    // The node's epoch is ahead (a commit event may still be on the way): catch up, which re-keys.
    useVoicePresence.subscribe((now) => {
      const epoch = now.epochs[key];
      const local = s.mls.epoch(s.q);
      if (epoch != null && local != null && epoch > local) void s.mls.catchUp(s.q).catch(() => undefined);
    }),
    useVoiceSettings.subscribe((now, prev) => void applySettings(s, now.settings, prev.settings)),
    // A stream tile appearing or going away changes what is audible while deafened.
    useWatchedStreams.subscribe(() => {
      if (current === s && useVoice.getState().deafened) applyVolumes(s);
    }),
  );
  const editable = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) && e.key.length === 1;
  };
  const down = (e: KeyboardEvent) => {
    if (e.repeat || editable(e)) return;
    if (settings().inputMode === "ptt" && e.code === settings().pttKey) s.pipeline.setPtt(true);
    // The priority key (design note 4.13 item 3): held = priority; with push-to-talk it also opens the mic.
    if (settings().priorityKey && e.code === settings().priorityKey) void setPriority(true);
  };
  const up = (e: KeyboardEvent) => {
    if (settings().inputMode === "ptt" && e.code === settings().pttKey) s.pipeline.setPtt(false);
    if (settings().priorityKey && e.code === settings().priorityKey) void setPriority(false);
  };
  // Leaving the window releases the keys of the window, not a global hotkey of the desktop app that is still held.
  const blur = () => {
    if (!desktopHeld("push_to_talk")) s.pipeline.setPtt(false);
    if (useVoice.getState().prioritySelf && !desktopHeld("priority")) void setPriority(false);
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  s.offs.push(() => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", blur);
  });
}

async function applySettings(s: Session, next: VoiceSettings, prev: VoiceSettings) {
  if (current !== s) return;
  try {
    await s.pipeline.apply(next);
    if (next.outputDeviceId !== prev.outputDeviceId) {
      await s.room.switchActiveDevice("audiooutput", next.outputDeviceId || "default");
      await s.pipeline.setOutputDevice(next.outputDeviceId);
    }
    if (next.outputVolume !== prev.outputVolume || next.userVolumes !== prev.userVolumes || next.streamVolumes !== prev.streamVolumes || next.streamWhileDeafened !== prev.streamWhileDeafened) applyVolumes(s);
    if (useVoice.getState().camera) {
      if (next.cameraDeviceId !== prev.cameraDeviceId && next.cameraDeviceId) await s.room.switchActiveDevice("videoinput", next.cameraDeviceId);
      if (next.background !== prev.background || next.backgroundImage !== prev.backgroundImage || next.backgroundQuality !== prev.backgroundQuality) await startBackground(s);
      else if (next.blurStrength !== prev.blurStrength) await s.background?.setBlur(next.blurStrength);
    }
  } catch (e) {
    useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

async function cleanup(s: Session) {
  s.leaving = true;
  s.offs.forEach((off) => off());
  s.offs = [];
  if (current === s) {
    current = null;
    batcher.clear();
    clearSoundOverlays();
    lastReport = { level: Number.NEGATIVE_INFINITY, open: false };
    applied.clear();
  }
  s.priority.clear();
  await stopBackground(s);
  await s.room.disconnect().catch(() => undefined);
  document.getElementById("tavrn-voice-audio")?.replaceChildren();
  for (const t of s.taps.values()) {
    t.analyser?.disconnect();
    t.duck.disconnect();
  }
  s.taps.clear();
  await s.audio?.close().catch(() => undefined);
  await s.pipeline.close();
  if (import.meta.env.DEV) delete (window as { __tavrnVoice?: unknown }).__tavrnVoice;
}

const kept = () => ({ muted: useVoice.getState().muted, deafened: useVoice.getState().deafened });

async function onDisconnected(s: Session, reason?: DisconnectReason) {
  if (s.leaving) return;
  const target = s.target;
  const graceMs = (s.info.reconnect_grace_secs ?? DEFAULT_GRACE_MS / 1000) * 1000;
  // The node removes a moved participant before it sends `voice.move`: remember the channel for a moment.
  if (reason === DisconnectReason.PARTICIPANT_REMOVED && !target.call) removed = { target, at: Date.now() };
  const before = nextId;
  await cleanup(s);
  // A move (or another join) took over while the old connection closed.
  if (nextId !== before) return;
  if (reason === DisconnectReason.PARTICIPANT_REMOVED && target.call) {
    // The call ended (the node closes its room): nothing to rejoin.
    set({ ...IDLE, ...kept() });
    return;
  }
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
    set({ ...IDLE, ...kept() });
    // A move arrives as `voice.move` right after the removal; another device of the same user took over
    // (one voice session per user); otherwise a moderator disconnected us.
    const id = nextId;
    await new Promise((r) => setTimeout(r, MOVE_GRACE_MS));
    if (nextId !== id || current) return;
    const elsewhere = Object.values(useVoicePresence.getState().channels).some((list) => list.some((p) => p.identity !== s.room.localParticipant.identity && p.identity.startsWith(`${splitIdentity(s.room.localParticipant.identity).address}/`)));
    useToasts.getState().push({ kind: "warning", title: t(elsewhere ? "voice.continued_elsewhere" : "voice.disconnected_by_moderator") });
    return;
  }
  if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.CLIENT_INITIATED || reason === DisconnectReason.DUPLICATE_IDENTITY) {
    set({ ...IDLE, ...kept() });
    return;
  }
  // The connection broke for good (network, LiveKit restart): rejoin with a fresh token for as long as the
  // node keeps the seat (design note 4.5 item 7), keeping mute/deafen and the MLS epoch (no self update).
  await rejoin(target, graceMs);
}

async function rejoin(target: VoiceTarget, graceMs: number) {
  const schedule = new RejoinSchedule(Date.now(), graceMs);
  set({ ...IDLE, ...kept(), status: "reconnecting", target });
  cue("connection_lost", true);
  for (let delay = schedule.next(Date.now()); delay !== null; delay = schedule.next(Date.now())) {
    await new Promise((r) => setTimeout(r, delay));
    // Cancelled (leave) or replaced by another join meanwhile.
    if (current || useVoice.getState().target !== target || useVoice.getState().status !== "reconnecting") return;
    try {
      await connect(target, false, { rejoin: true });
      return;
    } catch {
      if (useVoice.getState().target !== target) return;
      set({ status: "reconnecting" });
    }
  }
  if (useVoice.getState().target !== target) return;
  set({ ...IDLE, ...kept(), error: t("voice.error.connection_lost") });
  useToasts.getState().push({ kind: "warning", title: t("voice.error.connection_lost") });
}

async function connect(target: VoiceTarget, canCreate: boolean, opts: { rejoin?: boolean; start?: boolean } = {}) {
  const id = nextId++;
  set(opts.rejoin ? { target, error: null } : { status: "joining", target, error: null, e2eeBlocked: false });
  // E2EE is mandatory: without insertable streams (or RTCRtpScriptTransform) there is no voice.
  if (!isE2ESupportedSafe()) throw new VoiceError("e2ee_unsupported");
  const mls = await getMls();
  if (!mls) throw new VoiceError("locked");
  const q = qualify(target.domain, target.channelId);
  if ((await mls.ensureJoined(q, { canCreate })) === "no_group") throw new VoiceError("no_group");
  // Ghost leaves (deleted devices, this user's old devices) go before the new voice key (ENCRYPTION.md §4.7); the
  // node lists who is in the channel, so only those devices are online for the election. Best effort.
  if (!opts.rejoin) {
    const online = participantsOf(useVoicePresence.getState(), target.domain, target.channelId).map((p) => p.identity);
    await cleanupConversation(q, { members: null, mayManage: false, online }).catch(() => null);
  }
  // A fresh key for every voice session (ENCRYPTION.md §5a); best effort, the current epoch also works.
  // A rejoin after a dropped connection continues the session on the current epoch.
  if (!opts.rejoin) await mls.selfUpdate(q).catch(() => false);
  const api = apiFor(target.domain);
  const ep = endpoints(api, target);
  // Entitlement caps (stream/camera) are folded into the limits once (ENTITLEMENTS.md §4).
  const info = withEntitlementCaps(await ep.join(!!opts.start && !opts.rejoin));
  let pipeline: MicPipeline | null = null;
  let room: Room | null = null;
  let audio: AudioContext | null = null;
  try {
    if (info.epoch != null && (mls.epoch(q) ?? -1) < info.epoch) await mls.catchUp(q);
    const s0 = settings();
    pipeline = await MicPipeline.create(s0, onLevel);
    const keyProvider = new TavrnKeyProvider();
    const vk = mls.voiceKey(q);
    if (!vk) throw new VoiceError("e2ee_failed");
    try {
      await keyProvider.setEpochKey(vk.key, vk.epoch);
    } finally {
      vk.key.fill(0);
    }
    audio = newAudioContext();
    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Web Audio playback: per-user volume above 100 % and output device selection; our own context so
      // the analysers and ducking gains live in it (closed by `cleanup`).
      webAudioMix: audio ? { audioContext: audio } : true,
      encryption: { keyProvider, worker: new E2EEWorker() },
      ...(s0.outputDeviceId ? { audioOutput: { deviceId: s0.outputDeviceId } } : {}),
    });
    const reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const withAnalysers = analysersAvailable({ audioContext: !!audio, reducedMotion, weakDevice: !!document.documentElement.dataset.weakDevice });
    const s: Session = {
      id,
      target,
      q,
      api,
      ep,
      mls,
      room,
      pipeline,
      keyProvider,
      info,
      offs: [],
      leaving: false,
      mutedBeforeDeafen: false,
      clips: new Map(),
      background: null,
      audio,
      taps: new Map(),
      detector: withAnalysers ? new SpeakingDetector() : null,
      lkSpeakers: {},
      priority: new PriorityTracker(
        (identity) => verifyPriority(target, identity),
        (active) => applyDucking(s, active),
      ),
      signals: new SignalLimiter(),
    };
    current = s;
    // Re-key on every epoch change of the group from now on; an epoch that changed since the key above was
    // derived is picked up right away.
    s.offs.push(
      useMlsUi.subscribe((now, prev) => {
        if (now.epochs[s.q] !== prev.epochs[s.q]) void rekey(s);
      }),
    );
    void rekey(s);
    wire(s);
    await room.setE2EEEnabled(true);
    if (!room.localParticipant.isE2EEEnabled) throw new VoiceError("e2ee_failed");
    // Extra addresses of the media server (TAVRN_RTC_ADVERTISE_IPS, VOICE.md §10.2) for this call's connections.
    setIcePolicy({ aliases: info.ice_aliases ?? [] });
    await room.connect(info.url, info.token, { autoSubscribe: true });
    await confirmE2ee(room);
    if (current !== s) return;
    await room.startAudio().catch(() => undefined);
    const canSpeak = canPublish(room, Track.Source.Microphone);
    set({ status: "connected", identity: room.localParticipant.identity, limits: info.limits, canSpeak, serverMuted: !canSpeak, e2ee: true });
    if (canSpeak) await publishMic(s);
    applyVolumes(s);
    refreshMedia(s);
    follow(s);
    startSpeakingLoop(s);
    // Priority claims of those already in the call.
    for (const p of room.remoteParticipants.values()) followPriorityClaim(s, p);
    const { muted, deafened } = useVoice.getState();
    cue(opts.rejoin ? "connection_restored" : "join", true);
    await reportState(s, { muted: muted || !canSpeak, deafened });
    if (import.meta.env.DEV) exposeForTests(s);
  } catch (e) {
    const s = current;
    if (s && s.id === id) await cleanup(s);
    else {
      await room?.disconnect().catch(() => undefined);
      await audio?.close().catch(() => undefined);
      await pipeline?.close();
    }
    // A failed rejoin keeps the seat (the node holds it for the grace period); a failed join frees it.
    if (!opts.rejoin) await ep.leave().catch(() => undefined);
    throw e;
  }
}

/** The playback context of a call; null without Web Audio (LiveKit then plays through audio elements). */
function newAudioContext(): AudioContext | null {
  try {
    return typeof AudioContext === "undefined" ? null : new AudioContext({ latencyHint: "interactive" });
  } catch {
    return null;
  }
}

function isE2ESupportedSafe(): boolean {
  try {
    return isE2EESupported();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- public API (via index.ts)

/** Joins a voice channel (leaving the current one first: a device is in at most one channel). */
export function join(target: VoiceTarget, opts: { canCreate: boolean; start?: boolean }): Promise<void> {
  const run = async () => {
    if (current && sameTarget(current.target, target)) return;
    if (current) await leave();
    try {
      await connect(target, opts.canCreate, { start: opts.start });
    } catch (e) {
      console.warn("voice: joining failed", e);
      const blocked = e instanceof VoiceError && e.code === "e2ee_unsupported";
      set({ ...IDLE, muted: useVoice.getState().muted, deafened: useVoice.getState().deafened, error: voiceErrorMessage(e), e2eeBlocked: blocked });
      throw e;
    }
  };
  const next = (pending ?? Promise.resolve()).then(run, run);
  pending = next.catch(() => undefined);
  return next;
}

/** Leaves the call (LiveKit and the node); also cancels a running rejoin. */
export async function leave(): Promise<void> {
  const s = current;
  if (!s) {
    const { target, status } = useVoice.getState();
    set({ ...IDLE, ...kept() });
    // Cancelled while rejoining: give up the seat the node keeps for us.
    if (target && status === "reconnecting") await endpoints(apiFor(target.domain), target).leave().catch(() => undefined);
    return;
  }
  await cleanup(s);
  cue("leave", true);
  await s.ep.leave().catch(() => undefined);
  set({ ...IDLE, muted: useVoice.getState().muted, deafened: useVoice.getState().deafened });
}

/** `voice.move` of the room's node: rejoin in the target channel (other MLS group, other key). */
export async function followMove(domain: string, data: { room_id: string; from_channel_id: string; channel_id: string }): Promise<void> {
  // The current channel, or the one LiveKit just removed us from (the event may arrive after the removal).
  const recent = removed && Date.now() - removed.at < MOVE_GRACE_MS ? removed.target : null;
  const target = useVoice.getState().target ?? recent;
  removed = null;
  if (!target || target.call || target.domain !== domain || target.roomId !== data.room_id || target.channelId !== data.from_channel_id) return;
  const s = current;
  if (s) await cleanup(s);
  await join({ domain, roomId: data.room_id, channelId: data.channel_id }, { canCreate: true }).catch(() => undefined);
}

export async function setMuted(muted: boolean): Promise<void> {
  const s = current;
  const state = useVoice.getState();
  if (!muted && state.serverMuted) {
    useToasts.getState().push({ kind: "warning", title: t("errors.voice.server_muted") });
    return;
  }
  // Unmuting while deafened also undeafens (as everywhere else).
  const deafened = !muted && state.deafened ? false : state.deafened;
  set(muted ? { muted, deafened, transmitting: false } : { muted, deafened });
  if (s) cue(muted ? "mute" : "unmute", true);
  if (!s) return;
  // The own ring goes dark at once (the paused gate reports nothing any more).
  emitSpeakers(s);
  const pub = s.room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub) await (muted ? pub.mute() : pub.unmute());
  await s.pipeline.setPaused(muted);
  if (deafened !== state.deafened) applyVolumes(s);
  await reportState(s, { muted, ...(deafened !== state.deafened ? { deafened } : {}) });
}

export async function setDeafened(deafened: boolean): Promise<void> {
  const s = current;
  const state = useVoice.getState();
  // A deafened client also mutes itself (VOICE.md §5); undeafening restores the earlier mute state.
  let muted = state.muted;
  if (deafened) {
    if (s) s.mutedBeforeDeafen = state.muted;
    muted = true;
  } else if (s) muted = s.mutedBeforeDeafen || state.serverMuted;
  set({ deafened, muted });
  if (s) cue(deafened ? "deafen" : "undeafen", true);
  if (!s) return;
  emitSpeakers(s);
  applyVolumes(s);
  const pub = s.room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub) await (muted ? pub.mute() : pub.unmute());
  await s.pipeline.setPaused(muted);
  await reportState(s, { deafened, muted });
}

const bitrate = (w: number, h: number, fps: number, factor: number) => Math.min(8_000_000, Math.round(w * h * fps * factor));

export async function setCamera(on: boolean): Promise<void> {
  const s = current;
  if (!s) return;
  if (on && !s.info.limits.camera.enabled) return;
  try {
    if (on) {
      const opts = cameraOptions(settings(), s.info.limits.camera);
      await s.room.localParticipant.setCameraEnabled(
        true,
        { ...(opts.deviceId ? { deviceId: opts.deviceId } : {}), resolution: { width: opts.width, height: opts.height, frameRate: opts.frameRate } },
        { simulcast: true, videoCodec: "vp8", videoEncoding: { maxBitrate: bitrate(opts.width, opts.height, opts.frameRate, 0.06), maxFramerate: opts.frameRate } },
      );
      await startBackground(s);
    } else {
      await stopBackground(s);
      await s.room.localParticipant.setCameraEnabled(false);
    }
    refreshMedia(s);
    cue(on ? "stream_on" : "stream_off", true);
    await reportState(s, { camera: on });
  } catch (e) {
    useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

export interface ScreenShareOptions {
  audio: boolean;
  /** `720p` … `4k`, lowered to the node's maximum. */
  resolution: string;
  fps: number;
}

export async function setScreenShare(on: boolean, opts: ScreenShareOptions = { audio: true, resolution: "1080p", fps: 30 }): Promise<void> {
  const s = current;
  if (!s) return;
  const limit = s.info.limits.screenshare;
  if (on && !limit.enabled) return;
  try {
    if (on) {
      const order = ["720p", "1080p", "1440p", "4k"];
      const res = order.indexOf(opts.resolution) > order.indexOf(limit.max_resolution) && order.includes(limit.max_resolution) ? limit.max_resolution : opts.resolution;
      const size = resolutionSize(res);
      const fps = Math.max(1, Math.min(opts.fps, limit.max_fps));
      await s.room.localParticipant.setScreenShareEnabled(
        true,
        { audio: opts.audio, resolution: { ...size, frameRate: fps }, contentHint: fps > 15 ? "motion" : "detail", selfBrowserSurface: "exclude", systemAudio: "include" },
        { videoCodec: "vp8", screenShareEncoding: { maxBitrate: bitrate(size.width, size.height, fps, 0.05), maxFramerate: fps } },
      );
    } else {
      await s.room.localParticipant.setScreenShareEnabled(false);
    }
    refreshMedia(s);
    if (on === useVoice.getState().screen) cue(on ? "stream_on" : "stream_off", true);
    await reportState(s, { streaming: on && useVoice.getState().screen });
  } catch (e) {
    // The user closed the browser's source picker: nothing to report.
    if ((e as { name?: string }).name === "NotAllowedError" || (e as { name?: string }).name === "AbortError") return;
    useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

/** The clip's bytes are gone everywhere (design note 4.13). */
class ClipUnavailable extends Error {}

/** A clip to play: one of the room's, or (design note 4.13) a personal clip or one of another room on `node`. */
export type PlayableSound = Pick<Sound, "id"> & { node?: string; emoji?: string | null };

/**
 * Plays a soundboard clip into the own (encrypted) microphone track (VOICE.md §8). The node of the voice channel
 * is asked first (`use_external_sounds` for clips that are not the room's, design note 4.13); the audio comes from
 * the public route of the node hosting the clip.
 */
export async function playSound(sound: PlayableSound): Promise<void> {
  const s = current;
  const state = useVoice.getState();
  if (!s || state.muted || !state.canSpeak) return;
  const host = sound.node && sound.node !== s.target.domain ? sound.node : undefined;
  if (!s.target.call) await s.api.soundboard.play(s.target.roomId, s.target.channelId, sound.id, host);
  let clip = s.clips.get(sound.id);
  if (!clip) {
    // Through the voice channel's node: clips of other nodes come from its cached copy (`?host=`).
    clip = fetch(s.api.soundboard.audioUrl(sound.id, host))
      .then((r) => {
        if (!r.ok) throw new ClipUnavailable();
        return r.arrayBuffer();
      })
      .then((data) => s.pipeline.decode(data));
    s.clips.set(sound.id, clip);
    clip.catch(() => s.clips.delete(sound.id));
  }
  let buffer: AudioBuffer;
  try {
    buffer = await clip;
  } catch (e) {
    if (!(e instanceof ClipUnavailable)) throw e;
    useToasts.getState().push({ kind: "warning", title: t("voice.soundboard.unavailable") });
    return;
  }
  if (current !== s) return;
  signalSound(s, sound, buffer.duration * 1000, host);
  await s.pipeline.playClip(buffer, settings().outputVolume / 100);
}

/**
 * `soundboard.play` to the others (reliable, end-to-end encrypted data channel; needs `use_soundboard`, the
 * node grants data only with it) and the clip's emoji on the own tile. The sound's `emoji` (unicode or a
 * custom emoji token) is optional.
 */
function signalSound(s: Session, sound: PlayableSound, durationMs: number, host?: string) {
  const self = s.room.localParticipant;
  // A clip of another node: its custom emoji token without a host belongs to that node (design note 4.13).
  const raw = sound.emoji ?? undefined;
  const emoji = raw && host && /^<a?:[^@>]+>$/.test(raw) ? `${raw.slice(0, -1)}@${host}>` : raw;
  showSoundOverlay(self.identity, emoji, Math.min(5000, durationMs));
  if (!self.permissions?.canPublishData || !s.signals.allow("self", Date.now())) return;
  void self.publishData(encodeSoundSignal({ id: sound.id, emoji, host }, durationMs), { reliable: true, topic: SOUND_TOPIC }).catch((e: unknown) => console.warn("voice: soundboard signal failed", e));
}

/**
 * Priority speaker on or off (the key, or the toggle on touch devices). Needs `priority_speaker` in the
 * channel (the node grants attribute updates only then); with push-to-talk it also opens the microphone.
 */
export async function setPriority(on: boolean): Promise<void> {
  const s = current;
  if (!s) return;
  const local = s.room.localParticipant;
  if (on && !local.permissions?.canUpdateMetadata) return;
  if (useVoice.getState().prioritySelf === on) return;
  set({ prioritySelf: on });
  publishPriority(s);
  if (settings().inputMode === "ptt") s.pipeline.setPtt(on);
  try {
    await local.setAttributes({ priority: on ? "1" : "" });
  } catch (e) {
    console.warn("voice: priority attribute not set", e);
    if (on && current === s) {
      set({ prioritySelf: false });
      publishPriority(s);
    }
  }
}

/** Push-to-talk from an on-screen button (phones). */
export function pushToTalk(pressed: boolean): void {
  current?.pipeline.setPtt(pressed);
}

/** Attaches a participant's camera or screen video to an element; returns the detach function. */
export function attachVideo(identity: string, source: "camera" | "screen", el: HTMLVideoElement): () => void {
  const s = current;
  if (!s) return () => undefined;
  const p: Participant | undefined = identity === s.room.localParticipant.identity ? s.room.localParticipant : s.room.getParticipantByIdentity(identity);
  const track = p?.getTrackPublication(source === "camera" ? Track.Source.Camera : Track.Source.ScreenShare)?.track;
  if (!track) return () => undefined;
  track.attach(el);
  return () => {
    track.detach(el);
  };
}

// ---------------------------------------------------------------- background blur / replacement

async function startBackground(s: Session) {
  await stopBackground(s);
  const conf = settings();
  if (conf.background === "none" || current !== s) return;
  const track = s.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
  if (!(track instanceof LocalVideoTrack)) return;
  try {
    const { applyBackground } = await import("./background");
    s.background = await applyBackground(track, conf, (slow) => {
      markWeakDevice();
      void stopBackground(s);
      set({ backgroundAutoOff: slow });
      useToasts.getState().push({ kind: "warning", title: t("voice.settings.background_auto_off_title"), detail: t("voice.settings.background_auto_off", { ms: slow.averageMs, budget: slow.budgetMs, fps: slow.fps }) });
    });
  } catch (e) {
    useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

async function stopBackground(s: Session) {
  const bg = s.background;
  s.background = null;
  await bg?.stop().catch(() => undefined);
}

// ---------------------------------------------------------------- development: test hooks

interface TestHooks {
  room: Room;
  /** E2EE state as LiveKit reports it, the speakers and every track's encryption flag. */
  state: () => unknown;
  /** Peak of the audio decoded (and decrypted) from a participant over `ms` (Web Audio analyser). */
  inboundAudioPeak: (identity: string, ms?: number) => Promise<number>;
  /** Simulates a broken connection: the room goes away without the user leaving, the client rejoins. */
  drop: () => Promise<void>;
}

/** Development builds only: lets the Playwright specs check encryption and speaking via the SDK. */
function exposeForTests(s: Session) {
  const hooks: TestHooks = {
    room: s.room,
    state: () => ({
      e2eeEnabled: s.room.isE2EEEnabled,
      localEncrypted: s.room.localParticipant.isE2EEEnabled,
      keyIndex: s.keyProvider.getLatestManuallySetKeyIndex(),
      epoch: s.mls.epoch(s.q),
      local: { identity: s.room.localParticipant.identity, isSpeaking: s.room.localParticipant.isSpeaking, tracks: [...s.room.localParticipant.trackPublications.values()].map((p) => ({ source: p.source, encrypted: p.isEncrypted })) },
      speaking: analysing(s) ? "analyser" : "livekit",
      priority: [...s.priority.active],
      ducking: Object.fromEntries([...s.taps.values()].map((t) => [t.identity, t.duck.gain.value])),
      // Volumes as applied (`volume.ts`) and the gains LiveKit's Web Audio mix plays them with.
      volumes: Object.fromEntries([...applied].map(([identity, v]) => [identity, v])),
      gains: Object.fromEntries(
        [...s.room.remoteParticipants.values()].map((p) => {
          const gain = (source: Track.Source) => (p.getTrackPublication(source)?.track as { gainNode?: GainNode } | undefined)?.gainNode?.gain.value ?? null;
          return [p.identity, { microphone: gain(Track.Source.Microphone), stream: gain(Track.Source.ScreenShareAudio) }];
        }),
      ),
      remote: [...s.room.remoteParticipants.values()].map((p) => ({
        identity: p.identity,
        isSpeaking: p.isSpeaking,
        audioLevel: p.audioLevel,
        isEncrypted: p.isEncrypted,
        tracks: [...p.trackPublications.values()].map((pub) => ({ source: pub.source, encrypted: pub.isEncrypted, subscribed: pub.isSubscribed })),
      })),
    }),
    inboundAudioPeak: async (identity, ms = 2000) => {
      const track = s.room.getParticipantByIdentity(identity)?.getTrackPublication(Track.Source.Microphone)?.track;
      if (!track) return 0;
      const ctx = new AudioContext();
      try {
        const analyser = ctx.createAnalyser();
        ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let peak = 0;
        for (let t = 0; t < ms; t += 100) {
          await new Promise((r) => setTimeout(r, 100));
          analyser.getFloatTimeDomainData(buf);
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
        }
        return peak;
      } finally {
        await ctx.close();
      }
    },
    drop: async () => {
      s.leaving = true;
      await s.room.disconnect();
      s.leaving = false;
      await onDisconnected(s, DisconnectReason.SIGNAL_CLOSE);
    },
  };
  (window as { __tavrnVoice?: TestHooks }).__tavrnVoice = hooks;
}
