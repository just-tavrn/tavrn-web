// SPDX-License-Identifier: Apache-2.0
/**
 * The voice session of the native engine (`engine.ts`, docs/DESKTOP.md "Voice"): the desktop app's shell joins the
 * LiveKit room with LiveKit's Rust SDK, captures the microphone and plays the others (`platform().voice`); this module
 * does everything around it exactly like the browser engine (`session.ts`): the channel's MLS group and a fresh epoch
 * (ENCRYPTION.md §5a), the node's join, leave and state routes, the frame key of every epoch (handed to the shell, never
 * kept), mute and deafen with their rules (VOICE.md §5), per-user volumes (`volume.ts`), push-to-talk with its tones,
 * the speaking rings (the shell measures, `SpeakingDetector` decides as for the analysers), the notification sounds, the
 * rejoin after a broken connection and the follow of a moderator's move.
 *
 * Audio only: camera, screen sharing, soundboard clips and the priority speaker stay with the browser engine; the
 * controls say so instead of failing. Others' screen shares are never received (the shell does not subscribe them,
 * as the browser engine only does after "Join stream"); joining one shows a hint. Security rules as in the browser engine: the shell publishes only once the frame
 * cryptor of the own track is active (`e2ee_failed` otherwise) and has no unencrypted path.
 */
import { cleanupBeforeVoice, loadPending } from "../lib/leafCleanup";
import { holdGroupJoins } from "../crypto/groupJoins";
import { BackgroundLeaves, startJoin } from "./joinFlow";
import { apiFor } from "../stores/nodes";
import { getMls, useMlsUi } from "../stores/mls";
import { qualify, splitIdentity, type MlsManager } from "@tavrn/e2ee";
import { useToasts } from "../stores/toasts";
import { t } from "../i18n";
import { throttledActivity } from "../lib/idle";
import { platform, type NativeParticipant, type NativeVoiceEvent, type PlatformVoice } from "../platform";
import { VoiceError, voiceErrorMessage } from "./errors";
import { channelKey, participantsOf, useVoicePresence } from "./presence";
import { useVoiceSettings, type VoiceSettings } from "./settings";
import { withEntitlementCaps } from "./entitlementCaps";
import { IDLE, SpeakingBatcher, useVoice, type ParticipantMedia, type VoiceTarget } from "./store";
import { participantVolumes } from "./volume";
import { isLocallyMuted, useLocalMute } from "./localMute";
import { SPEAKING_POLL_MS, SpeakingDetector, combineLevels, localLevel } from "./speaking";
import { DEFAULT_GRACE_MS, RejoinSchedule } from "./reconnect";
import { playCue, type Cue } from "./cues";
import { hotkeyHeld } from "./hotkeys";
import { PttCues } from "./pttCues";
import { isMusic } from "./quality";
import { VoiceKeyRing } from "./keys";
import { nativeConfig } from "./engine";
import { endpoints, followOthers, type Endpoints, type JoinInfo } from "./sessionShared";
import type { PlayableSound, ScreenShareOptions } from "./session";

/** After a removal by a moderator, a `voice.move` may follow: wait this long before giving up. */
const MOVE_GRACE_MS = 2_000;

interface Session {
  id: number;
  target: VoiceTarget;
  q: string;
  ep: Endpoints;
  mls: MlsManager;
  voice: PlatformVoice;
  info: JoinInfo;
  identity: string;
  offs: Array<() => void>;
  ring: VoiceKeyRing;
  pttCues: PttCues;
  leaving: boolean;
  mutedBeforeDeafen: boolean;
  detector: SpeakingDetector;
  level: { level: number; open: boolean };
  /** The remote identities as the shell last listed them. */
  remotes: Set<string>;
}

let current: Session | null = null;
let removed: { target: VoiceTarget; at: number } | null = null;
let nextId = 1;
let pending: Promise<void> | null = null;
const batcher = new SpeakingBatcher(100);
const talking = throttledActivity(30_000);

const set = (patch: Partial<ReturnType<typeof useVoice.getState>>) => useVoice.setState(patch);
const cue = (c: Cue, own: boolean) => playCue(c, { own, deafened: useVoice.getState().deafened });
const settings = () => useVoiceSettings.getState().settings;
const sameTarget = (a: VoiceTarget | null, b: VoiceTarget) => !!a && a.domain === b.domain && a.roomId === b.roomId && a.channelId === b.channelId && !!a.call === !!b.call;
const kept = () => ({ muted: useVoice.getState().muted, deafened: useVoice.getState().deafened });

/** The shell's error codes as the client's voice errors. */
function shellError(e: unknown): unknown {
  const code = typeof e === "string" ? e : null;
  if (!code) return e;
  if (code === "voice.e2ee_failed") return new VoiceError("e2ee_failed");
  if (code === "voice.connect_failed" || code === "voice.publish_failed") return new VoiceError("connect_failed");
  if (code === "voice.native_unavailable") return new VoiceError("native_unavailable");
  if (code.startsWith("voice.no_input") || code.startsWith("voice.input_failed") || code.startsWith("voice.no_output") || code.startsWith("voice.output_failed") || code === "voice.device_format") return new VoiceError("native_device");
  return new VoiceError("connect_failed");
}

function voiceApi(): PlatformVoice {
  const v = platform().voice;
  if (!v) throw new VoiceError("native_unavailable");
  return v;
}

async function reportState(s: Session, patch: { muted?: boolean; deafened?: boolean }) {
  try {
    await s.ep.updateState(patch);
  } catch (e) {
    if ((e as { code?: string }).code !== "voice.not_connected") useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

/** Writes the speakers: the own ring from the gate, the others from the shell's levels through the detector. */
function emitSpeakers(s: Session, now = performance.now()) {
  if (current !== s) return;
  const state = useVoice.getState();
  const own = localLevel(s.level, state.muted || !state.canSpeak);
  batcher.speakers(combineLevels({ identity: s.identity, level: own }, s.detector.levels(now)));
}

/** Per-user playback gains (`volume.ts`): deafen silences the voices; streams do not exist in this engine. */
function applyVolumes(s: Session, deafened = useVoice.getState().deafened) {
  const conf = settings();
  const gains: Record<string, number> = {};
  for (const identity of s.remotes) {
    const address = splitIdentity(identity).address;
    gains[identity] = participantVolumes(conf, address, { deafened, watched: false, localMuted: isLocallyMuted(useLocalMute.getState(), address) }).microphone;
  }
  void s.voice.setVolumes(gains).catch(() => undefined);
}

function onParticipants(s: Session, list: NativeParticipant[]) {
  const media: Record<string, ParticipantMedia> = {};
  const remotes = new Set<string>();
  for (const p of list) {
    media[p.identity] = { camera: false, screen: false, micMuted: !p.mic || p.mic_muted, screenAudio: false };
    if (!p.local) remotes.add(p.identity);
  }
  const added = [...remotes].some((id) => !s.remotes.has(id));
  for (const id of s.remotes) if (!remotes.has(id)) s.detector.forget(id);
  s.remotes = remotes;
  set({ media });
  if (added) applyVolumes(s);
}

function onEvent(s: Session, e: NativeVoiceEvent) {
  if (current !== s) return;
  switch (e.kind) {
    case "level": {
      s.level = { level: e.level ?? Number.NEGATIVE_INFINITY, open: e.open };
      const state = useVoice.getState();
      const open = e.open && !state.muted;
      if (state.transmitting !== open) set({ transmitting: open });
      if (open && state.canSpeak) talking();
      emitSpeakers(s);
      return;
    }
    case "ptt":
      s.pttCues.mic(e.open);
      return;
    case "speakers": {
      const now = performance.now();
      for (const [identity, db] of e.levels) s.detector.push(identity, db ?? Number.NEGATIVE_INFINITY, now);
      emitSpeakers(s, now);
      return;
    }
    case "participants":
      onParticipants(s, e.participants);
      return;
    case "permissions":
      // A server mute revokes the microphone grant (VOICE.md §7); the self mute stays the user's.
      set(e.can_speak ? { canSpeak: true, serverMuted: false } : { canSpeak: false, serverMuted: true, muted: true });
      if (!e.can_speak) void s.voice.setMuted(true).catch(() => undefined);
      emitSpeakers(s);
      return;
    case "quality":
      if (e.identity === s.identity) set({ quality: e.quality });
      if (useVoice.getState().qualities[e.identity] !== e.quality) useVoice.setState((st) => ({ qualities: { ...st.qualities, [e.identity]: e.quality } }));
      return;
    case "encryption":
      if (e.state !== "ok" && e.state !== "new") console.warn("voice: encryption state", e.identity, e.state);
      return;
    case "reconnecting":
      set({ status: "reconnecting" });
      cue("connection_lost", true);
      return;
    case "reconnected":
      set({ status: "connected" });
      cue("connection_restored", true);
      return;
    case "disconnected":
      void onDisconnected(s, e.reason);
      return;
    case "error":
      useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(shellError(e.code)) });
      return;
  }
}

/** Re-keys after an epoch change of the channel's group (ENCRYPTION.md §5a): the shell gets the newer key. */
async function rekey(s: Session) {
  if (current !== s) return;
  const vk = s.mls.voiceKey(s.q);
  if (!vk || !s.ring.needs(vk.epoch)) {
    vk?.key.fill(0);
    return;
  }
  try {
    s.ring.mark(vk.epoch);
    await s.voice.setKey(vk.key, vk.epoch);
  } catch (e) {
    console.warn("voice: the native engine refused the key", e);
  } finally {
    vk.key.fill(0);
  }
}

function follow(s: Session) {
  const key = channelKey(s.target.domain, s.target.channelId);
  s.offs.push(
    followOthers(s.target, key, () => s.identity, () => current === s, cue),
    // The node's epoch is ahead (a commit event may still be on the way): catch up, which re-keys.
    useVoicePresence.subscribe((now) => {
      const epoch = now.epochs[key];
      const local = s.mls.epoch(s.q);
      if (epoch != null && local != null && epoch > local) void s.mls.catchUp(s.q).catch(() => undefined);
    }),
    useVoiceSettings.subscribe((now, prev) => void applySettings(s, now.settings, prev.settings)),
    // "Mute for you" (issue #124) is applied like a volume.
    useLocalMute.subscribe(() => {
      if (current === s) applyVolumes(s);
    }),
  );
  // The speaking rings fade without new levels (somebody stopped talking): the detector's hold runs out.
  const timer = setInterval(() => emitSpeakers(s), SPEAKING_POLL_MS * 2);
  s.offs.push(() => clearInterval(timer));
}

async function applySettings(s: Session, next: VoiceSettings, prev: VoiceSettings) {
  if (current !== s) return;
  try {
    const music = isMusic(s.info.limits.audio_bitrate_kbps);
    if (JSON.stringify(nativeConfig(next, music)) !== JSON.stringify(nativeConfig(prev, music))) await s.voice.configure(nativeConfig(next, music));
    if (next.outputVolume !== prev.outputVolume || next.userVolumes !== prev.userVolumes) applyVolumes(s);
  } catch (e) {
    useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(shellError(e)) });
  }
}

async function cleanup(s: Session) {
  s.leaving = true;
  s.offs.forEach((off) => off());
  s.offs = [];
  if (current === s) {
    current = null;
    batcher.clear();
  }
  s.detector.clear();
  await s.voice.leave().catch(() => undefined);
}

async function onDisconnected(s: Session, reason: string) {
  if (s.leaving) return;
  const target = s.target;
  const graceMs = (s.info.reconnect_grace_secs ?? DEFAULT_GRACE_MS / 1000) * 1000;
  if (reason === "participant_removed" && !target.call) removed = { target, at: Date.now() };
  const before = nextId;
  await cleanup(s);
  if (nextId !== before) return;
  if (reason === "participant_removed") {
    set({ ...IDLE, ...kept() });
    if (target.call) return;
    const id = nextId;
    await new Promise((r) => setTimeout(r, MOVE_GRACE_MS));
    if (nextId !== id || current) return;
    const self = splitIdentity(s.identity).address;
    const elsewhere = Object.values(useVoicePresence.getState().channels).some((list) => list.some((p) => p.identity !== s.identity && p.identity.startsWith(`${self}/`)));
    useToasts.getState().push({ kind: "warning", title: t(elsewhere ? "voice.continued_elsewhere" : "voice.disconnected_by_moderator") });
    return;
  }
  if (reason === "room_deleted" || reason === "client_initiated" || reason === "duplicate_identity") {
    set({ ...IDLE, ...kept() });
    return;
  }
  await rejoin(target, graceMs);
}

async function rejoin(target: VoiceTarget, graceMs: number) {
  const schedule = new RejoinSchedule(Date.now(), graceMs);
  set({ ...IDLE, ...kept(), status: "reconnecting", target });
  cue("connection_lost", true);
  for (let delay = schedule.next(Date.now()); delay !== null; delay = schedule.next(Date.now())) {
    await new Promise((r) => setTimeout(r, delay));
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
  const voice = voiceApi();
  const mls = await getMls();
  if (!mls) throw new VoiceError("locked");
  const q = qualify(target.domain, target.channelId);
  const ep = endpoints(apiFor(target.domain), target);
  // Ghost leaves first, without waiting for the election, then the fresh voice key (ENCRYPTION.md §4.7, §5a), with
  // voice/join in parallel (joinFlow.ts). The shell gets the key with its join, so it waits for the fresh epoch.
  const online = () => participantsOf(useVoicePresence.getState(), target.domain, target.channelId).map((p) => p.identity);
  const flow = await startJoin({
    mls,
    q,
    canCreate,
    rejoin: !!opts.rejoin,
    join: async () => withEntitlementCaps(await ep.join(!!opts.start && !opts.rejoin)),
    leave: () => ep.leave(),
    pending: () => loadPending(q),
    cleanup: (pending) => cleanupBeforeVoice(q, { online, pending }),
    hold: holdGroupJoins,
  });
  const { info } = flow;
  let joined = false;
  try {
    await flow.fresh;
    const vk = mls.voiceKey(q);
    if (!vk) throw new VoiceError("e2ee_failed");
    const ring = new VoiceKeyRing();
    const s: Session = {
      id,
      target,
      q,
      ep,
      mls,
      voice,
      info,
      identity: "",
      offs: [],
      ring,
      pttCues: new PttCues((c) => cue(c, true), {
        allowed: () => {
          const v = useVoice.getState();
          return v.canSpeak && !v.serverMuted && !v.muted;
        },
      }),
      leaving: false,
      mutedBeforeDeafen: false,
      detector: new SpeakingDetector(),
      level: { level: Number.NEGATIVE_INFINITY, open: false },
      remotes: new Set(),
    };
    const { muted, deafened } = useVoice.getState();
    current = s;
    let reply: { identity: string; can_speak: boolean };
    try {
      ring.mark(vk.epoch);
      reply = await voice.join(
        { url: info.url, token: info.token, key: vk.key, epoch: vk.epoch, bitrateKbps: info.limits.audio_bitrate_kbps, config: nativeConfig(settings(), isMusic(info.limits.audio_bitrate_kbps)), muted, deafened },
        (e) => onEvent(s, e),
      );
    } catch (e) {
      throw shellError(e);
    } finally {
      vk.key.fill(0);
    }
    joined = true;
    if (current !== s) return;
    s.identity = reply.identity;
    // A hotkey held while joining keeps transmitting from the start.
    if (hotkeyHeld("push_to_talk")) void voice.setPtt(true).catch(() => undefined);
    // Re-key on every epoch change from now on; an epoch that changed since the key above is picked up at once.
    s.offs.push(
      useMlsUi.subscribe((now, prev) => {
        if (now.epochs[s.q] !== prev.epochs[s.q]) void rekey(s);
      }),
    );
    void rekey(s);
    const canSpeak = reply.can_speak;
    set({ status: "connected", identity: reply.identity, limits: info.limits, canSpeak, serverMuted: !canSpeak, e2ee: true, ...(canSpeak ? {} : { muted: true }) });
    applyVolumes(s);
    follow(s);
    cue(opts.rejoin ? "connection_restored" : "join", true);
    flow.cleanupLater();
    await reportState(s, { muted: useVoice.getState().muted || !canSpeak, deafened });
  } catch (e) {
    const s = current;
    if (s && s.id === id) await cleanup(s);
    else if (joined) await voice.leave().catch(() => undefined);
    // A failed rejoin keeps the seat; a failed join frees it.
    await flow.abandon();
    throw e;
  }
}

// ---------------------------------------------------------------- the engine's API (the same as session.ts)

export function join(target: VoiceTarget, opts: { canCreate: boolean; start?: boolean }): Promise<void> {
  const run = async () => {
    if (current && sameTarget(current.target, target)) return;
    // Switching channels: the node's leave of the previous one runs in the background (BackgroundLeaves).
    if (current) await leaveForSwitch(current);
    await backgroundLeaves.settled(targetKey(target));
    try {
      await connect(target, opts.canCreate, { start: opts.start });
    } catch (e) {
      console.warn("voice: joining failed (native engine)", e);
      set({ ...IDLE, muted: useVoice.getState().muted, deafened: useVoice.getState().deafened, error: voiceErrorMessage(e) });
      throw e;
    }
  };
  const next = (pending ?? Promise.resolve()).then(run, run);
  pending = next.catch(() => undefined);
  return next;
}

/** Leaves of earlier channels on their way to the node while the next one is joined. */
const backgroundLeaves = new BackgroundLeaves();
const targetKey = (t: VoiceTarget) => `${t.call ? "call" : "channel"}:${t.domain}/${t.roomId}/${t.channelId}`;

/** Ends the session on this device at once; the node learns it in the background (the next join does not wait). */
async function leaveForSwitch(s: Session) {
  await cleanup(s);
  cue("leave", true);
  backgroundLeaves.start(targetKey(s.target), () => s.ep.leave());
}

export async function leave(): Promise<void> {
  const s = current;
  if (!s) {
    const { target, status } = useVoice.getState();
    set({ ...IDLE, ...kept() });
    if (target && status === "reconnecting") await endpoints(apiFor(target.domain), target).leave().catch(() => undefined);
    return;
  }
  await cleanup(s);
  cue("leave", true);
  await s.ep.leave().catch(() => undefined);
  set({ ...IDLE, ...kept() });
}

export async function followMove(domain: string, data: { room_id: string; from_channel_id: string; channel_id: string }): Promise<void> {
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
  const deafened = !muted && state.deafened ? false : state.deafened;
  set(muted ? { muted, deafened, transmitting: false } : { muted, deafened });
  if (!s) return;
  cue(muted ? "mute" : "unmute", true);
  emitSpeakers(s);
  await s.voice.setMuted(muted).catch(() => undefined);
  if (deafened !== state.deafened) {
    await s.voice.setDeafened(deafened).catch(() => undefined);
    applyVolumes(s, deafened);
  }
  await reportState(s, { muted, ...(deafened !== state.deafened ? { deafened } : {}) });
}

export async function setDeafened(deafened: boolean): Promise<void> {
  const s = current;
  const state = useVoice.getState();
  let muted = state.muted;
  if (deafened) {
    if (s) s.mutedBeforeDeafen = state.muted;
    muted = true;
  } else if (s) muted = s.mutedBeforeDeafen || state.serverMuted;
  set({ deafened, muted });
  if (!s) return;
  cue(deafened ? "deafen" : "undeafen", true);
  emitSpeakers(s);
  await s.voice.setDeafened(deafened).catch(() => undefined);
  applyVolumes(s, deafened);
  await s.voice.setMuted(muted).catch(() => undefined);
  await reportState(s, { deafened, muted });
}

/** Camera, screen sharing, soundboard clips and the priority speaker: not in the native engine (the controls say so). */
export async function setCamera(_on: boolean): Promise<void> {}

export async function setScreenShare(_on: boolean, _opts?: ScreenShareOptions): Promise<void> {}

export async function playSound(_sound: PlayableSound): Promise<void> {}

export async function setPriority(_on: boolean): Promise<void> {}

/** Push-to-talk held or released (the in-window key, the hold button); the shell also hears the system-wide hotkey. */
export function pushToTalk(pressed: boolean): void {
  const s = current;
  if (!s) return;
  void s.voice.setPtt(pressed).catch(() => undefined);
}

export function attachVideo(_identity: string, _source: "camera" | "screen", _el: HTMLVideoElement): () => void {
  return () => undefined;
}

/**
 * Streams (screen shares) cannot be watched with this engine: the shell plays audio only and never subscribes a
 * screen share's video or audio (`src-tauri/src/voice/engine.rs`, opt-in like the browser engine). Joining one says so.
 */
export function joinStream(_identity: string): void {
  useToasts.getState().push({ kind: "info", title: t("voice.stream.native_unavailable"), testId: "stream-native-hint" });
}

export function leaveStream(_identity: string): void {}
