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
 *
 * Screen shares are opt-in (`streams.ts`): the room connects without auto-subscription; microphones and cameras
 * are subscribed as they are published, a screen share's video and audio only once this viewer joined it.
 */
import { platform } from "../platform";
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
  type RemoteTrackPublication,
} from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import type { Sound, TavrnApi } from "@tavrn/sdk";
import { apiFor } from "../stores/nodes";
import { getMls, useMlsUi } from "../stores/mls";
import { qualify, splitIdentity, type MlsManager } from "@tavrn/e2ee";
import { useToasts } from "../stores/toasts";
import { t } from "../i18n";
import { MicPipeline } from "./audio";
import { isMusic, micPublishOptions } from "./quality";
import { markWeakDevice } from "./frames";
import { TavrnKeyProvider } from "./keyProvider";
import { VoiceError, voiceErrorMessage } from "./errors";
import { channelKey, participantsOf, useVoicePresence } from "./presence";
import { cameraOptions, phoneCameras, resolutionSize, useVoiceSettings, type VoiceSettings } from "./settings";
import { withEntitlementCaps } from "./entitlementCaps";
import { IDLE, SpeakingBatcher, isWatched, useSoundOverlays, useVoice, useWatchedStreams, type ParticipantMedia, type Quality, type VoiceTarget } from "./store";
import { participantVolumes, type Volumes } from "./volume";
import { isLocallyMuted, useLocalMute } from "./localMute";
import { ANALYSER_SIZE, SPEAKING_POLL_MS, SpeakingDetector, analysersAvailable, combineLevels, localLevel, rmsDb } from "./speaking";
import { PriorityTracker, claimsPriority, duckGain, rampTo, verifyPriority } from "./priority";
import { SOUND_TOPIC, SignalLimiter, encodeSoundSignal, parseClipEmoji, parseSoundSignal } from "./soundSignal";
import { throttledActivity } from "../lib/idle";
import type { LevelReport } from "./audio";
import { DEFAULT_GRACE_MS, RejoinSchedule } from "./reconnect";
import { playCue, type Cue } from "./cues";
import { setIcePolicy } from "./ice";
import { hotkeyHeld } from "./hotkeys";
import { PttCues } from "./pttCues";
import { CaptureRelease } from "./capture";
import { MutedTalkDetector } from "./mutedTalk";
import type { BackgroundHandle } from "./background";
import { endpoints, followOthers as followOthersOf, type Endpoints, type JoinInfo } from "./sessionShared";
import { StreamSubscriptions, streamIdentity } from "./streams";
import { NativeScreenShare, NoFrameKeyError } from "./nativeScreen";

/** LiveKit must confirm encryption for this device within this time, else nothing is published. */
const E2EE_CONFIRM_MS = 10_000;
/** After a removal by a moderator, a `voice.move` may follow: wait this long before giving up. */
const MOVE_GRACE_MS = 2_000;

interface Session {
  id: number;
  target: VoiceTarget;
  q: string;
  api: TavrnApi;
  ep: Endpoints;
  mls: MlsManager;
  room: Room;
  pipeline: MicPipeline;
  /** Releases the microphone capture while muted (`capture.ts`). */
  capture: CaptureRelease;
  /** Talking while muted (`mutedTalk.ts`, issue #125): the detector, the pulse timer and whether the toast was shown this mute. */
  mutedTalk: MutedTalkDetector;
  mutedTalkPulse: ReturnType<typeof setTimeout> | null;
  mutedTalkSaid: boolean;
  keyProvider: TavrnKeyProvider;
  info: JoinInfo;
  offs: Array<() => void>;
  /** The push-to-talk key (or the hold button) is held. */
  pttHeld: boolean;
  /** The tones of push-to-talk and the priority key (issue #37). */
  pttCues: PttCues;
  leaving: boolean;
  /** Mute state to restore when undeafening. */
  mutedBeforeDeafen: boolean;
  clips: Map<string, Promise<AudioBuffer>>;
  background: BackgroundHandle | null;
  /** Which camera the camera track was opened with (`cameraKey`); re-enabling reuses the track, so a change since then restarts it. */
  cameraKey: string | null;
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
  /** The streams this device joined and the subscriptions that follow (screen shares are opt-in). */
  streams: StreamSubscriptions;
  /** The Android app's screen share through the shell (VOICE.md §4b); null elsewhere. */
  nativeScreen: NativeScreenShare | null;
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

/**
 * A participant's media. A remote screen share counts from its publication on (before it is joined, the stream tile
 * offers joining); its video is there only once joined and subscribed. The own share counts once its track runs.
 */
function mediaOf(p: Participant, local: boolean): ParticipantMedia {
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const screen = p.getTrackPublication(Track.Source.ScreenShare);
  const screenAudio = p.getTrackPublication(Track.Source.ScreenShareAudio);
  return {
    camera: !!cam?.track && !cam.isMuted,
    screen: local ? !!screen?.track : !!screen,
    screenVideo: !!screen?.track,
    micMuted: !mic || mic.isMuted,
    screenAudio: local ? !!screenAudio?.track : !!screenAudio,
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
  const open = r.open && !state.muted;
  if (state.transmitting !== open) set({ transmitting: open });
  const s = current;
  if (!s) return;
  if (open && state.canSpeak) talking();
  if (mutedTalkListens(state)) {
    if (s.mutedTalk.push(r.level, performance.now())) mutedTalkHint(s);
  } else {
    s.mutedTalk.reset();
    s.mutedTalkSaid = false;
  }
  emitSpeakers(s);
}

/**
 * The talking-while-muted hint (issue #125) listens while the user muted the microphone (the toggle; a released
 * push-to-talk key is not a mute) with the setting on, not while deafened (the user stepped away) or server-muted
 * (they could not unmute anyway).
 */
function mutedTalkListens(state = useVoice.getState()): boolean {
  return state.muted && !state.deafened && !state.serverMuted && state.canSpeak && settings().mutedTalkHint;
}

/** The hint: the soft cue, the microphone button pulses for a moment, and once per mute a short notice (announced). */
function mutedTalkHint(s: Session) {
  cue("muted_talk", true);
  set({ mutedTalk: true });
  if (s.mutedTalkPulse) clearTimeout(s.mutedTalkPulse);
  s.mutedTalkPulse = setTimeout(() => {
    s.mutedTalkPulse = null;
    if (current === s) set({ mutedTalk: false });
  }, 2_500);
  if (s.mutedTalkSaid) return;
  s.mutedTalkSaid = true;
  useToasts.getState().push({ kind: "info", title: t("voice.muted_talk.toast"), testId: "muted-talk-hint" });
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
  const media: Record<string, ParticipantMedia> = { [s.room.localParticipant.identity]: mediaOf(s.room.localParticipant, true) };
  for (const p of s.room.remoteParticipants.values()) media[p.identity] = mediaOf(p, false);
  const localId = s.room.localParticipant.identity;
  const local = media[localId]!;
  // A stream that ended is forgotten: the next share of that person is joined anew.
  s.streams.prune((id) => !!media[id]?.screen);
  const focus = useVoice.getState().focus;
  const focusable = (id: string) => !!media[id]?.screen && (id === localId || s.streams.isJoined(id));
  set({ media, camera: local.camera, screen: local.screen, focus: focus && focusable(focus) ? focus : null });
}

/** The volumes last applied per identity (development test hooks). */
const applied = new Map<string, Volumes>();

/**
 * Playback volumes of a remote participant (`volume.ts`, issue #20): the voice volume on the microphone, the
 * stream volume on the screen share audio, both times the output volume; deafen silences the voice, and the
 * stream too unless it is watched (and "stream audio while deafened" is on). A person muted for this user
 * (`localMute.ts`, issue #124) gets zero on both.
 */
function applyVolume(p: RemoteParticipant, deafened = useVoice.getState().deafened) {
  const address = splitIdentity(p.identity).address;
  const v = participantVolumes(settings(), address, { deafened, watched: isWatched(useWatchedStreams.getState(), p.identity), localMuted: isLocallyMuted(useLocalMute.getState(), address) });
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
    // The Android app's screen publisher encrypts with this device's key too (VOICE.md §4b): it gets every epoch's.
    if (s.nativeScreen?.active) void s.nativeScreen.rekey({ key: vk.key.slice(), epoch: vk.epoch }).catch(() => undefined);
    await s.keyProvider.setEpochKey(vk.key, vk.epoch);
  } finally {
    vk.key.fill(0);
  }
}

async function publishMic(s: Session) {
  if (!canPublish(s.room, Track.Source.Microphone) || s.room.localParticipant.getTrackPublication(Track.Source.Microphone)) return;
  // Never publish before encryption is confirmed for this device (VOICE.md §6).
  if (!s.room.isE2EEEnabled || !s.room.localParticipant.isE2EEEnabled) throw new VoiceError("e2ee_failed");
  // Quality presets and music mode (VOICE.md §4a): stereo only for a real two-channel capture.
  const kbps = s.info.limits.audio_bitrate_kbps;
  const pub = await s.room.localParticipant.publishTrack(s.pipeline.track, {
    source: Track.Source.Microphone,
    ...micPublishOptions(kbps, { music: isMusic(kbps), stereo: s.pipeline.stereo }),
  });
  if (useVoice.getState().muted) {
    await pub.mute();
    s.pipeline.setMuted(true);
    await applyMutedCapture(s, true);
  }
}

function onPermissions(s: Session) {
  // The node revokes the microphone grant on a server mute (VOICE.md §7) and restores it on unmute; the
  // self mute stays the user's (a server mute leaves the user muted).
  const canSpeak = canPublish(s.room, Track.Source.Microphone);
  set(canSpeak ? { canSpeak, serverMuted: false } : { canSpeak, serverMuted: true, muted: true });
  if (!canSpeak) void s.capture.setMuted(true);
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
    .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
      // Microphones and cameras at once, screen shares only once joined (`streams.ts`).
      if (current === s) s.streams.apply(p.identity, pub);
      media();
    })
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
  return followOthersOf(s.target, key, () => s.room.localParticipant.identity, () => current === s, cue);
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
    // "Mute for you" (issue #124) is applied like a volume.
    useLocalMute.subscribe(() => {
      if (current === s) applyVolumes(s);
    }),
  );
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
    // The talking-while-muted hint switched while muted: start or stop listening (the capture and the graph).
    if (next.mutedTalkHint !== prev.mutedTalkHint && useVoice.getState().muted) await applyMutedCapture(s, true);
    if (useVoice.getState().camera) {
      if (next.cameraDeviceId !== prev.cameraDeviceId || next.cameraFacing !== prev.cameraFacing) await switchCamera(s, next);
      if (next.background !== prev.background || next.backgroundImage !== prev.backgroundImage || next.backgroundQuality !== prev.backgroundQuality) await startBackground(s);
      else if (next.blurStrength !== prev.blurStrength) await s.background?.setBlur(next.blurStrength);
    }
  } catch (e) {
    useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

/** The camera the settings name: a device id, else (phones) the facing. */
const cameraKey = (conf: VoiceSettings) => (conf.cameraDeviceId ? `id:${conf.cameraDeviceId}` : phoneCameras() ? `facing:${conf.cameraFacing}` : "default");

/**
 * The running camera follows the settings without leaving the call: a camera chosen by id (`switchActiveDevice`), else
 * the default camera or, on phones, the front or back one (the track restarts with the `facingMode` constraint; a
 * phone cannot open both cameras at once, LiveKit stops the old track first and keeps the background effect).
 */
async function switchCamera(s: Session, next: VoiceSettings) {
  s.cameraKey = cameraKey(next);
  if (next.cameraDeviceId) {
    await s.room.switchActiveDevice("videoinput", next.cameraDeviceId);
    return;
  }
  const track = s.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
  if (!(track instanceof LocalVideoTrack)) return;
  const opts = cameraOptions(next, s.info.limits.camera, phoneCameras());
  await track.restartTrack({ ...(opts.facingMode ? { facingMode: opts.facingMode } : {}), resolution: { width: opts.width, height: opts.height, frameRate: opts.frameRate } });
  refreshMedia(s);
}

async function cleanup(s: Session) {
  if (s.mutedTalkPulse) clearTimeout(s.mutedTalkPulse);
  s.leaving = true;
  // The screen publisher ends with the voice session (the node also removes it with this device).
  void s.nativeScreen?.dispose();
  s.capture.close();
  s.offs.forEach((off) => off());
  s.offs = [];
  if (current === s) {
    current = null;
    batcher.clear();
    clearSoundOverlays();
    set({ streams: {} });
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
    pipeline = await MicPipeline.create(s0, onLevel, { music: isMusic(info.limits.audio_bitrate_kbps) });
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
      // The Android app keeps the capture while muted: its notification unmutes in the background (capture.ts).
      capture: new CaptureRelease(pipeline, undefined, !!platform().android),
      mutedTalk: new MutedTalkDetector(() => settings().vadThreshold),
      mutedTalkPulse: null,
      mutedTalkSaid: false,
      keyProvider,
      info,
      offs: [],
      // A hotkey held while joining keeps transmitting from the start.
      pttHeld: hotkeyHeld("push_to_talk"),
      pttCues: new PttCues((c) => cue(c, true), {
        // Not while the server keeps the microphone closed or the user muted it: nothing would be sent.
        allowed: () => {
          const v = useVoice.getState();
          return v.canSpeak && !v.serverMuted && !v.muted;
        },
      }),
      leaving: false,
      mutedBeforeDeafen: false,
      clips: new Map(),
      background: null,
      cameraKey: null,
      audio,
      taps: new Map(),
      detector: withAnalysers ? new SpeakingDetector() : null,
      lkSpeakers: {},
      priority: new PriorityTracker(
        (identity) => verifyPriority(target, identity),
        (active) => applyDucking(s, active),
      ),
      signals: new SignalLimiter(),
      streams: new StreamSubscriptions(
        () => room!.remoteParticipants.values(),
        (joined) => {
          if (current === s) set({ streams: Object.fromEntries([...joined].map((id) => [id, true as const])) });
        },
      ),
      nativeScreen: null,
    };
    s.nativeScreen = nativeScreenFor(s);
    current = s;
    s.pipeline.onPtt = (open) => s.pttCues.mic(open);
    if (s.pttHeld) applyPtt(s);
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
    // Screen shares are opt-in: nothing is subscribed by itself, `streams` subscribes what this viewer wants.
    await room.connect(info.url, info.token, { autoSubscribe: false });
    s.streams.applyAll();
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
  set(muted ? { muted, deafened, transmitting: false } : { muted, deafened, mutedTalk: false });
  if (s) cue(muted ? "mute" : "unmute", true);
  if (!s) return;
  // The own ring goes dark at once (the paused gate reports nothing any more).
  emitSpeakers(s);
  if (!(await applyMute(s, muted))) return;
  if (deafened !== state.deafened) applyVolumes(s);
  await reportState(s, { muted, ...(deafened !== state.deafened ? { deafened } : {}) });
}

/**
 * Mutes or unmutes the microphone publication, the pipeline and the capture (`capture.ts`: released a moment after a
 * mute, re-acquired before an unmute takes effect). An unmute whose microphone cannot be opened again (unplugged,
 * permission withdrawn) stays muted with a warning; returns false then.
 */
async function applyMute(s: Session, muted: boolean): Promise<boolean> {
  if (!muted) {
    try {
      await s.capture.setMuted(false);
    } catch (e) {
      if (current !== s) return false;
      set({ muted: true, transmitting: false });
      useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
      await reportState(s, { muted: true });
      return false;
    }
  }
  const pub = s.room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (pub) await (muted ? pub.mute() : pub.unmute());
  s.pipeline.setMuted(muted);
  await applyMutedCapture(s, muted);
  return true;
}

/**
 * The capture and the graph while muted: asleep and released (`capture.ts`), unless the talking-while-muted hint
 * listens (`mutedTalkListens`): then both keep running on the closed gate, so the level reports go on. Unmuted:
 * running (the capture was re-acquired by the caller).
 */
async function applyMutedCapture(s: Session, muted: boolean): Promise<void> {
  const listen = muted && mutedTalkListens();
  await s.pipeline.setPaused(muted && !listen);
  if (muted && !listen) await s.capture.setMuted(true);
  // Listening again (the setting turned on, undeafened while muted): the capture may have been released meanwhile.
  else if (listen) await s.capture.setMuted(false).catch(() => undefined);
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
  if (!(await applyMute(s, muted))) {
    await reportState(s, { deafened });
    return;
  }
  await reportState(s, { deafened, muted });
}

const bitrate = (w: number, h: number, fps: number, factor: number) => Math.min(8_000_000, Math.round(w * h * fps * factor));

export async function setCamera(on: boolean): Promise<void> {
  const s = current;
  if (!s) return;
  if (on && !s.info.limits.camera.enabled) return;
  try {
    if (on) {
      const conf = settings();
      const opts = cameraOptions(conf, s.info.limits.camera, phoneCameras());
      // Turning the camera on again unmutes the earlier track with its old constraints: a camera chosen since then
      // (the menu while the camera was off) restarts it.
      const reused = !!s.room.localParticipant.getTrackPublication(Track.Source.Camera) && s.cameraKey !== null && s.cameraKey !== cameraKey(conf);
      await s.room.localParticipant.setCameraEnabled(
        true,
        { ...(opts.deviceId ? { deviceId: opts.deviceId } : {}), ...(opts.facingMode ? { facingMode: opts.facingMode } : {}), resolution: { width: opts.width, height: opts.height, frameRate: opts.frameRate } },
        { simulcast: true, videoCodec: "vp8", videoEncoding: { maxBitrate: bitrate(opts.width, opts.height, opts.frameRate, 0.06), maxFramerate: opts.frameRate } },
      );
      if (reused) await switchCamera(s, conf);
      s.cameraKey = cameraKey(conf);
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

/**
 * Joins the stream (screen share) of `identity`: its video and audio are received from now on. A member's device
 * whose screen publisher shares (the Android app, VOICE.md §4b) has its stream joined there.
 */
export function joinStream(identity: string): void {
  const s = current;
  if (!s || identity === s.room.localParticipant.identity) return;
  const target = streamIdentity(identity, (id) => !!useVoice.getState().media[id]?.screen);
  if (s.streams.join(target)) refreshMedia(s);
}

/** The Android app's screen share for this session (`nativeScreen.ts`), when the shell offers it. */
function nativeScreenFor(s: Session): NativeScreenShare | null {
  const shell = platform().android?.screenShare;
  if (!shell) return null;
  return new NativeScreenShare({
    shell,
    join: () => s.ep.joinScreen(),
    leave: () => s.ep.leaveScreen(),
    key: () => s.mls.voiceKey(s.q),
    notice: () => ({ title: t("voice.screen.notice_title"), text: t("voice.screen.notice_text"), stop: t("voice.screen.notice_stop") }),
    onState: (state, reason) => {
      if (current !== s) return;
      const before = useVoice.getState().nativeScreen;
      set({ nativeScreen: state });
      if (state === "live" && before !== "live") cue("stream_on", true);
      if (state === null && before === "live") cue("stream_off", true);
      if (reason === "failed") useToasts.getState().push({ kind: "warning", title: t("voice.screen.native_failed") });
    },
  });
}

/** The Android app's screen share: start (Android asks for consent) or stop it. */
async function setNativeScreenShare(s: Session, native: NativeScreenShare, on: boolean, opts: ScreenShareOptions): Promise<void> {
  if (!on) return native.stop();
  try {
    await native.start(opts, s.info.limits.screenshare);
  } catch (e) {
    // The user declined Android's dialog: nothing to report.
    if (e === "screen.cancelled") return;
    useToasts.getState().push({ kind: "warning", title: e instanceof NoFrameKeyError ? voiceErrorMessage(new VoiceError("e2ee_failed")) : typeof e === "string" ? t("voice.screen.native_failed") : voiceErrorMessage(e) });
  }
}

/** Leaves the stream of `identity` again: nothing of it is received, its tile is a placeholder. */
export function leaveStream(identity: string): void {
  const s = current;
  if (!s) return;
  s.streams.leave(identity);
  if (useVoice.getState().focus === identity) set({ focus: null });
  refreshMedia(s);
}

export async function setScreenShare(on: boolean, opts: ScreenShareOptions = { audio: true, resolution: "1080p", fps: 30 }): Promise<void> {
  const s = current;
  if (!s) return;
  const limit = s.info.limits.screenshare;
  if (on && !limit.enabled) return;
  // The Android app: the webview cannot share the screen, the shell's screen publisher does (VOICE.md §4b).
  if (s.nativeScreen) return setNativeScreenShare(s, s.nativeScreen, on, opts);
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
  s.pttCues.priority(on);
  applyPtt(s);
  try {
    await local.setAttributes({ priority: on ? "1" : "" });
  } catch (e) {
    console.warn("voice: priority attribute not set", e);
    if (on && current === s) {
      set({ prioritySelf: false });
      publishPriority(s);
      s.pttCues.priority(false);
      applyPtt(s);
    }
  }
}

/**
 * Push-to-talk mode: the microphone transmits while the push-to-talk key (or the hold button of phones) or the
 * priority key is held; releasing one keeps it open while the other is still held.
 */
function applyPtt(s: Session): void {
  s.pipeline.setPtt(s.pttHeld || useVoice.getState().prioritySelf);
}

/** Push-to-talk held or released (the hotkey, the hold button of phones). */
export function pushToTalk(pressed: boolean): void {
  const s = current;
  if (!s) return;
  s.pttHeld = pressed;
  applyPtt(s);
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

/** The publisher a development build plays for the simulated Android shell (`fakeScreenPublisher`). */
interface FakeScreenPublisher {
  setKey(key: number[], epoch: number): Promise<unknown>;
  stop(): Promise<void>;
}

/**
 * Development builds only: what the Android app's native screen publisher does (`ScreenShare.kt`, VOICE.md §4b),
 * played in the page for the Playwright fake of the shell (e2e/tests/android-helpers.ts): a second LiveKit
 * connection with the screen publisher's token that encrypts with the frame key the client handed over and
 * publishes a moving canvas as the screen share.
 */
async function fakeScreenPublisher(a: { url: string; token: string; key: number[]; epoch: number }): Promise<FakeScreenPublisher> {
  const keyProvider = new TavrnKeyProvider();
  await keyProvider.setEpochKey(new Uint8Array(a.key), a.epoch);
  const room = new Room({ encryption: { keyProvider, worker: new E2EEWorker() } });
  await room.setE2EEEnabled(true);
  await room.connect(a.url, a.token, { autoSubscribe: false });
  await confirmE2ee(room);
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext("2d")!;
  let hue = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${(hue += 7) % 360} 60% 40%)`;
    g.fillRect(0, 0, canvas.width, canvas.height);
  }, 100);
  const track = canvas.captureStream(10).getVideoTracks()[0]!;
  await room.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, videoCodec: "vp8" });
  return {
    setKey: (key, epoch) => keyProvider.setEpochKey(new Uint8Array(key), epoch),
    stop: async () => {
      clearInterval(timer);
      track.stop();
      await room.disconnect();
    },
  };
}

if (import.meta.env.DEV) (window as { __tavrnFakeScreenPublisher?: typeof fakeScreenPublisher }).__tavrnFakeScreenPublisher = fakeScreenPublisher;

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
      // The microphone capture is open (released while muted, `capture.ts`; kept while the muted-talk hint listens).
      capturing: s.pipeline.capturing,
      mutedTalkListening: mutedTalkListens(),
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
      streams: s.streams.joined(),
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
