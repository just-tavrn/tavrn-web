// SPDX-License-Identifier: Apache-2.0
/**
 * The life of a voice session around the media, shared by both engines (`session.ts`, `nativeSession.ts`): the join
 * queue (one join at a time, a switch leaves the previous channel in the background), leaving (also while a join is
 * still running: the attempt is cancelled), the follow of a moderator's move, what a lost connection means
 * (VOICE.md §7) and the rejoin within the node's grace period, and the state rules of mute and deafen (§5). Each
 * engine supplies only what touches its media: `connect`, `cleanup` and the device's identity. No LiveKit import: the
 * native engine loads it without livekit-client.
 *
 * Leaving while joining: `leave()` cancels every join requested before it. A queued join does not start; the running
 * attempt is told through its {@link Attempt} and gives up at its next step (`check()` throws {@link JoinCancelled}),
 * releasing the media and freeing the seat the node may have given; a session it already created is closed at once
 * (the microphone stops). A cancelled join ends silently: no error, no toast.
 */
import { splitIdentity } from "@tavrn/e2ee";
import type { VoiceStatePatch } from "@tavrn/sdk";
import { t } from "../i18n";
import { useToasts } from "../stores/toasts";
import { VoiceError, voiceErrorMessage } from "./errors";
import { BackgroundLeaves } from "./joinFlow";
import { useVoicePresence } from "./presence";
import { DEFAULT_GRACE_MS, RejoinSchedule } from "./reconnect";
import { endpoints, type Endpoints, type JoinInfo } from "./sessionShared";
import { apiFor } from "../stores/nodes";
import { IDLE, useVoice, type VoiceTarget } from "./store";
import type { Cue } from "./cues";

/** After a removal by a moderator, a `voice.move` may follow: wait this long before giving up. */
export const MOVE_GRACE_MS = 2_000;

/** Why the media connection ended, in both engines' terms (LiveKit's `DisconnectReason`, the shell's codes). */
export type DisconnectKind = "participant_removed" | "room_deleted" | "client_initiated" | "duplicate_identity" | "other";

/** The join was cancelled by a leave; not an error. */
export class JoinCancelled extends Error {
  constructor() {
    super("voice: join cancelled");
    this.name = "JoinCancelled";
  }
}

/** What the lifecycle needs of an engine's session. */
export interface LifecycleSession {
  id: number;
  target: VoiceTarget;
  ep: Endpoints;
  info: JoinInfo;
  /** Set by the engine's cleanup: events of a closing session are ignored. */
  leaving: boolean;
  /** Mute state to restore when undeafening. */
  mutedBeforeDeafen: boolean;
}

/** One run of an engine's `connect`. */
export interface Attempt {
  readonly id: number;
  readonly target: VoiceTarget;
  /** A leave came since the attempt started. */
  readonly cancelled: boolean;
  /** Throws {@link JoinCancelled} when cancelled: call after every step that waits. */
  check(): void;
}

export interface ConnectOpts {
  rejoin?: boolean;
  start?: boolean;
}

export interface EngineOps<S extends LifecycleSession> {
  /** For the log lines ("" for the browser engine). */
  label: string;
  /**
   * Connects `attempt.target`: creates the session, hands it over with `lifecycle.current = s` and resolves once it
   * is connected. On a failure (also {@link JoinCancelled}) it closes what it started, gives the seat back
   * (`JoinFlow.abandon`) and rethrows.
   */
  connect(attempt: Attempt, canCreate: boolean, opts: ConnectOpts): Promise<void>;
  /** Closes the session's media (sets `leaving`, clears `current` when it is the current one). */
  cleanup(s: S): Promise<void>;
  /** This device's identity in the call. */
  identity(s: S): string;
  /** Join timings (`joinTimings.ts`). */
  mark?(stage: string, detail?: Record<string, unknown>): void;
}

const set = (patch: Partial<ReturnType<typeof useVoice.getState>>) => useVoice.setState(patch);
/** Mute and deafen survive the end of a session. */
export const kept = () => ({ muted: useVoice.getState().muted, deafened: useVoice.getState().deafened });
export const sameTarget = (a: VoiceTarget | null, b: VoiceTarget) => !!a && a.domain === b.domain && a.roomId === b.roomId && a.channelId === b.channelId && !!a.call === !!b.call;
export const targetKey = (t: VoiceTarget) => `${t.call ? "call" : "channel"}:${t.domain}/${t.roomId}/${t.channelId}`;

/** Reports the own flags to the node; 409 `voice.not_connected` right after joining (the reservation expired) is harmless. */
export async function reportState(ep: Endpoints, patch: VoiceStatePatch): Promise<void> {
  try {
    await ep.updateState(patch);
  } catch (e) {
    if ((e as { code?: string }).code !== "voice.not_connected") useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

export class SessionLifecycle<S extends LifecycleSession> {
  /** The session of this device (connected, or created by a join that is still running). */
  current: S | null = null;
  /** The channel a moderator just removed this device from (a `voice.move` may follow, `followMove`). */
  private removed: { target: VoiceTarget; at: number } | null = null;
  private nextId = 1;
  private pending: Promise<void> | null = null;
  /** Bumped by every leave: joins and attempts of an older generation are cancelled. */
  private generation = 0;
  private readonly running = new Set<Attempt>();
  /** Leaves of earlier channels on their way to the node while the next one is joined. */
  readonly backgroundLeaves = new BackgroundLeaves();

  constructor(
    private readonly ops: EngineOps<S>,
    private readonly cue: (c: Cue, own: boolean) => void,
  ) {}

  /** A join is running. */
  get joining(): boolean {
    return this.running.size > 0;
  }

  /** Closes the media of `s` once (a session that is closing already is left alone). */
  private async close(s: S): Promise<void> {
    if (!s.leaving) await this.ops.cleanup(s);
  }

  private attempt(target: VoiceTarget, generation: number): Attempt {
    const id = this.nextId++;
    const lifecycle = this;
    return {
      id,
      target,
      get cancelled() {
        return generation !== lifecycle.generation;
      },
      check() {
        if (generation !== lifecycle.generation) throw new JoinCancelled();
      },
    };
  }

  /** One connect of the engine; `joining` while it runs. */
  private async connect(target: VoiceTarget, canCreate: boolean, opts: ConnectOpts, generation: number): Promise<void> {
    const attempt = this.attempt(target, generation);
    attempt.check();
    this.running.add(attempt);
    try {
      set(opts.rejoin ? { target, error: null } : { status: "joining", target, error: null, e2eeBlocked: false });
      await this.ops.connect(attempt, canCreate, opts);
      attempt.check();
    } catch (e) {
      // Whatever failed after a leave (the node's answer, the media connection the leave closed) is the cancellation.
      throw attempt.cancelled ? new JoinCancelled() : e;
    } finally {
      this.running.delete(attempt);
    }
  }

  /** Joins a voice channel (leaving the current one first: a device is in at most one channel). */
  join(target: VoiceTarget, opts: { canCreate: boolean; start?: boolean }): Promise<void> {
    const generation = this.generation;
    const run = async () => {
      // A leave came after this join was asked for.
      if (generation !== this.generation) return;
      if (this.current && sameTarget(this.current.target, target)) return;
      // Switching channels: the node's leave of the previous one runs in the background (BackgroundLeaves).
      if (this.current) await this.leaveForSwitch(this.current);
      await this.backgroundLeaves.settled(targetKey(target));
      try {
        await this.connect(target, opts.canCreate, { start: opts.start }, generation);
      } catch (e) {
        if (e instanceof JoinCancelled) return;
        console.warn(`voice: joining failed${this.ops.label}`, e);
        const blocked = e instanceof VoiceError && e.code === "e2ee_unsupported";
        set({ ...IDLE, ...kept(), error: voiceErrorMessage(e), e2eeBlocked: blocked });
        throw e;
      }
    };
    const next = (this.pending ?? Promise.resolve()).then(run, run);
    this.pending = next.catch(() => undefined);
    return next;
  }

  /** Ends the session on this device at once; the node learns it in the background (the next join does not wait). */
  private async leaveForSwitch(s: S): Promise<void> {
    await this.close(s);
    this.cue("leave", true);
    this.backgroundLeaves.start(targetKey(s.target), () => s.ep.leave());
  }

  /** Leaves the call (the media and the node); cancels a join that is still running and a rejoin. */
  async leave(): Promise<void> {
    this.generation++;
    const s = this.current;
    const { target, status } = useVoice.getState();
    if (this.running.size > 0) {
      // A join on its way: it gives the seat back itself when it notices (`Attempt.check`); what it already opened
      // (the microphone, the media connection) closes now.
      set({ ...IDLE, ...kept() });
      if (s) await this.close(s);
      // A rejoin attempt keeps the seat when it fails: give it up here.
      if (target && status === "reconnecting") await endpoints(apiFor(target.domain), target).leave().catch(() => undefined);
      return;
    }
    if (!s) {
      set({ ...IDLE, ...kept() });
      // Cancelled while rejoining: give up the seat the node keeps for us.
      if (target && status === "reconnecting") await endpoints(apiFor(target.domain), target).leave().catch(() => undefined);
      return;
    }
    this.ops.mark?.("leave_start");
    await this.close(s);
    this.cue("leave", true);
    await s.ep.leave().catch(() => undefined);
    this.ops.mark?.("leave_done");
    set({ ...IDLE, ...kept() });
  }

  /** `voice.move` of the room's node: rejoin in the target channel (other MLS group, other key). */
  async followMove(domain: string, data: { room_id: string; from_channel_id: string; channel_id: string }): Promise<void> {
    // The current channel, or the one the media server just removed us from (the event may arrive after the removal).
    const recent = this.removed && Date.now() - this.removed.at < MOVE_GRACE_MS ? this.removed.target : null;
    const target = useVoice.getState().target ?? recent;
    this.removed = null;
    if (!target || target.call || target.domain !== domain || target.roomId !== data.room_id || target.channelId !== data.from_channel_id) return;
    const s = this.current;
    if (s) await this.close(s);
    await this.join({ domain, roomId: data.room_id, channelId: data.channel_id }, { canCreate: true }).catch(() => undefined);
  }

  /** The media connection of `s` ended (VOICE.md §7): idle, a move to follow, or a rejoin within the grace period. */
  async onDisconnected(s: S, reason: DisconnectKind): Promise<void> {
    if (s.leaving) return;
    const target = s.target;
    const graceMs = (s.info.reconnect_grace_secs ?? DEFAULT_GRACE_MS / 1000) * 1000;
    const identity = this.ops.identity(s);
    // The node removes a moved participant before it sends `voice.move`: remember the channel for a moment.
    if (reason === "participant_removed" && !target.call) this.removed = { target, at: Date.now() };
    const before = this.nextId;
    await this.ops.cleanup(s);
    // A move (or another join) took over while the old connection closed.
    if (this.nextId !== before) return;
    if (reason === "participant_removed") {
      set({ ...IDLE, ...kept() });
      // The call ended (the node closes its room): nothing to rejoin.
      if (target.call) return;
      // A move arrives as `voice.move` right after the removal; another device of the same user took over (one voice
      // session per user); otherwise a moderator disconnected us.
      const id = this.nextId;
      await new Promise((r) => setTimeout(r, MOVE_GRACE_MS));
      if (this.nextId !== id || this.current) return;
      const self = splitIdentity(identity).address;
      const elsewhere = Object.values(useVoicePresence.getState().channels).some((list) => list.some((p) => p.identity !== identity && p.identity.startsWith(`${self}/`)));
      useToasts.getState().push({ kind: "warning", title: t(elsewhere ? "voice.continued_elsewhere" : "voice.disconnected_by_moderator") });
      return;
    }
    if (reason === "room_deleted" || reason === "client_initiated" || reason === "duplicate_identity") {
      set({ ...IDLE, ...kept() });
      return;
    }
    // The connection broke for good (network, media server restart): rejoin with a fresh token for as long as the
    // node keeps the seat (design note 4.5 item 7), keeping mute/deafen and the MLS epoch (no self update).
    await this.rejoin(target, graceMs);
  }

  private async rejoin(target: VoiceTarget, graceMs: number): Promise<void> {
    const generation = this.generation;
    const schedule = new RejoinSchedule(Date.now(), graceMs);
    set({ ...IDLE, ...kept(), status: "reconnecting", target });
    this.cue("connection_lost", true);
    for (let delay = schedule.next(Date.now()); delay !== null; delay = schedule.next(Date.now())) {
      await new Promise((r) => setTimeout(r, delay));
      // Cancelled (leave) or replaced by another join meanwhile.
      if (generation !== this.generation || this.current || useVoice.getState().target !== target || useVoice.getState().status !== "reconnecting") return;
      try {
        await this.connect(target, false, { rejoin: true }, generation);
        return;
      } catch (e) {
        if (e instanceof JoinCancelled || useVoice.getState().target !== target) return;
        set({ status: "reconnecting" });
      }
    }
    if (useVoice.getState().target !== target) return;
    set({ ...IDLE, ...kept(), error: t("voice.error.connection_lost") });
    useToasts.getState().push({ kind: "warning", title: t("voice.error.connection_lost") });
  }

  /**
   * The state change of a mute toggle (VOICE.md §5): refused while server-muted (with a notice), unmuting while
   * deafened also undeafens. Returns the session to apply it to (null without one, or when refused) and whether the
   * deafen state changed with it.
   */
  mute(muted: boolean): { s: S | null; deafened: boolean; deafenChanged: boolean } | null {
    const state = useVoice.getState();
    if (!muted && state.serverMuted) {
      useToasts.getState().push({ kind: "warning", title: t("errors.voice.server_muted") });
      return null;
    }
    const deafened = !muted && state.deafened ? false : state.deafened;
    set(muted ? { muted, deafened, transmitting: false } : { muted, deafened, mutedTalk: false });
    const s = this.current;
    if (s) this.cue(muted ? "mute" : "unmute", true);
    return { s, deafened, deafenChanged: deafened !== state.deafened };
  }

  /**
   * The state change of a deafen toggle (VOICE.md §5): a deafened client also mutes itself; undeafening restores the
   * earlier mute state (muted while server-muted). Returns the session to apply it to and the resulting mute state.
   */
  deafen(deafened: boolean): { s: S | null; muted: boolean } {
    const s = this.current;
    const state = useVoice.getState();
    let muted = state.muted;
    if (deafened) {
      if (s) s.mutedBeforeDeafen = state.muted;
      muted = true;
    } else if (s) muted = s.mutedBeforeDeafen || state.serverMuted;
    set({ deafened, muted });
    if (s) this.cue(deafened ? "deafen" : "undeafen", true);
    return { s, muted };
  }
}
