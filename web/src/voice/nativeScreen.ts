// SPDX-License-Identifier: Apache-2.0
/**
 * Screen sharing in the Android app (VOICE.md §4b, docs/ANDROID.md "Screen sharing"). The webview cannot share the
 * screen (no `getDisplayMedia`, and its WebRTC takes no video from Android's screen capture), so the shell publishes
 * it with the native LiveKit SDK as this device's *screen publisher*: a second participant `<identity>#screen` the node
 * issues a publish-only token for (`voice/join` / `call/join` with `role: "screen"`). This controller runs that
 * from the voice session:
 *
 * - **start**: the node's token for the screen publisher, then the shell (Android's consent dialog, the foreground
 *   service with its notification, the connection) with this device's frame key of the current epoch;
 * - **keys**: every later epoch's key goes to the shell as soon as the session derived it (the publisher is no MLS
 *   member; the key never leaves the device, ENCRYPTION.md §5a);
 * - **stop**: from the voice controls, the "You are streaming" bar, the notification's button or Android (the
 *   projection was revoked): the shell disconnects and the node is told (`voice/leave` with `role: "screen"`).
 *   Leaving voice ends it too (the node also removes a screen publisher with its device).
 *
 * No LiveKit import: the session hands in the node routes, the key and the shell; the tests hand in fakes.
 */
import type { VoiceLimits } from "@tavrn/sdk";
import type { AndroidScreenEvent, AndroidScreenShare, AndroidScreenStopReason } from "../platform/types";
import { limitResolution, resolutionSize, type Resolution } from "./settings";

export type NativeScreenState = "starting" | "live" | null;

/** What the user picked in the screen share dialog. */
export interface NativeScreenOptions {
  resolution: string;
  fps: number;
  /** The sound of other apps (Android 10+). */
  audio: boolean;
}

/** A frame key of an epoch (a copy the controller wipes after use). */
export interface EpochKey {
  key: Uint8Array;
  epoch: number;
}

export interface NativeScreenDeps {
  shell: AndroidScreenShare;
  /** The screen publisher's join at the node (`role: "screen"`). */
  join(): Promise<{ url: string; token: string }>;
  /** The screen publisher's leave at the node (`role: "screen"`). */
  leave(): Promise<unknown>;
  /** This device's frame key of the current epoch (a fresh copy), or null before there is one. */
  key(): EpochKey | null;
  /** The notification's texts in the client's language. */
  notice(): { title: string; text: string; stop: string };
  /** Every state change, with the reason when the share stopped by itself (not through `stop`). */
  onState(state: NativeScreenState, reason?: AndroidScreenStopReason): void;
}

/** A start that is refused before anything happened: the session has no frame key yet (never publish without). */
export class NoFrameKeyError extends Error {
  constructor() {
    super("voice.e2ee_failed");
  }
}

/** What the shell captures: the resolution's box (either orientation), the frame rate and the bitrate. */
export function screenCapture(opts: Pick<NativeScreenOptions, "resolution" | "fps">, limit: VoiceLimits["screenshare"]): { maxSide: number; fps: number; maxBitrate: number } {
  const size = resolutionSize(limitResolution(opts.resolution as Resolution, limit.max_resolution));
  const fps = Math.max(1, Math.min(opts.fps, limit.max_fps || 30));
  // The browser's screen share uses the same budget (`setScreenShare` in session.ts).
  const maxBitrate = Math.min(8_000_000, Math.round(size.width * size.height * fps * 0.05));
  return { maxSide: Math.max(size.width, size.height), fps, maxBitrate };
}

const wipe = (k: EpochKey | null) => k?.key.fill(0);

export class NativeScreenShare {
  private state: "idle" | "starting" | "live" = "idle";
  /** The newest epoch the shell has the key of. */
  private sent = -1;
  /** A key that arrived while starting, handed over once the shell runs. */
  private pending: EpochKey | null = null;
  private readonly off: () => void;

  constructor(private readonly deps: NativeScreenDeps) {
    this.off = deps.shell.onEvent((e) => this.onEvent(e));
  }

  /** Starting or live. */
  get active(): boolean {
    return this.state !== "idle";
  }

  private set(state: "idle" | "starting" | "live", reason?: AndroidScreenStopReason) {
    this.state = state;
    this.deps.onState(state === "idle" ? null : state, reason);
  }

  /** Starts the share; rejects (after cleaning up) when the user declined or anything failed. */
  async start(opts: NativeScreenOptions, limit: VoiceLimits["screenshare"]): Promise<void> {
    if (this.state !== "idle" || !limit.enabled) return;
    this.set("starting");
    let joined = false;
    let key: EpochKey | null = null;
    try {
      key = this.deps.key();
      if (!key) throw new NoFrameKeyError();
      const info = await this.deps.join();
      joined = true;
      if (this.state === "idle") {
        // Stopped while the node answered.
        await this.deps.leave().catch(() => undefined);
        return;
      }
      const capture = screenCapture(opts, limit);
      await this.deps.shell.start({ url: info.url, token: info.token, key: key.key, epoch: key.epoch, ...capture, audio: opts.audio && this.deps.shell.audio, notice: this.deps.notice() });
      this.sent = Math.max(this.sent, key.epoch);
      if (this.state === "idle") return;
      if (this.state === "starting") this.set("live");
      const pending = this.pending;
      this.pending = null;
      if (pending) await this.rekey(pending);
    } catch (e) {
      wipe(this.pending);
      this.pending = null;
      if (this.state !== "idle") this.set("idle");
      if (joined) await this.deps.leave().catch(() => undefined);
      throw e;
    } finally {
      wipe(key);
    }
  }

  /** Stops the share (the controls, the bar, leaving voice). */
  async stop(): Promise<void> {
    if (this.state === "idle") return;
    this.set("idle");
    wipe(this.pending);
    this.pending = null;
    this.sent = -1;
    await this.deps.shell.stop().catch(() => undefined);
    await this.deps.leave().catch(() => undefined);
  }

  /** The key of a new epoch: to the shell while sharing (the copy is wiped). Older epochs are ignored. */
  async rekey(k: EpochKey): Promise<void> {
    if (this.state === "idle" || k.epoch <= Math.max(this.sent, this.pending?.epoch ?? -1)) {
      wipe(k);
      return;
    }
    if (this.state === "starting") {
      wipe(this.pending);
      this.pending = k;
      return;
    }
    this.sent = k.epoch;
    try {
      await this.deps.shell.setKey(k.key, k.epoch);
    } finally {
      wipe(k);
    }
  }

  private onEvent(e: AndroidScreenEvent) {
    if (e.state === "live") {
      if (this.state === "starting") this.set("live");
      return;
    }
    if (this.state === "idle") return;
    // Stopped by the notification, Android or an error: the node lets the screen publisher go.
    this.set("idle", e.reason);
    wipe(this.pending);
    this.pending = null;
    this.sent = -1;
    void this.deps.leave().catch(() => undefined);
  }

  /** The voice session ends: stop sharing and stop listening. */
  async dispose(): Promise<void> {
    this.off();
    await this.stop();
  }
}
