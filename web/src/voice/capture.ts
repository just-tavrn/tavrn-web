// SPDX-License-Identifier: Apache-2.0
/**
 * The microphone capture while muted (browser engine). As long as a `getUserMedia` track with echo cancellation is
 * open, Chromium on Android keeps the device in its call audio mode (`MODE_IN_COMMUNICATION`): output streams opened
 * meanwhile play as voice-call audio with the call volume, and on many phones remote voices then sound far quieter
 * than with echo cancellation off. Muting only disabled the published track, so the capture (and the call audio
 * mode) stayed open the whole call.
 *
 * Now a mute releases the capture after a short grace period (a quick mute and unmute stays instant, no new
 * `getUserMedia`), and an unmute re-acquires it with the same constraints and device. The published track is the
 * pipeline's own (`audio.ts`), so nothing is republished. Push-to-talk closes only the gate, never the capture:
 * opening the microphone on every key press would cost a `getUserMedia` round trip (often hundreds of milliseconds)
 * and cut off the first syllable, so in push-to-talk mode the capture stays open while unmuted.
 *
 * The Android app keeps the capture open while muted (`keep`): its voice notification unmutes while the app is in the
 * background, where the webview opens no new capture until the app is on screen again (docs/ANDROID.md "Voice in
 * the background").
 */

/** A mute releases the capture this long after it (a quick mute and unmute keeps it). */
export const CAPTURE_GRACE_MS = 2_000;

export interface Capture {
  readonly capturing: boolean;
  releaseCapture(): void;
  reacquireCapture(): Promise<void>;
}

export class CaptureRelease {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly mic: Capture,
    private readonly graceMs = CAPTURE_GRACE_MS,
    private readonly keep = false,
  ) {}

  /** Follows the mute state: releases after the grace period, re-acquires at once on unmute. */
  setMuted(muted: boolean): Promise<void> {
    if (muted) {
      if (!this.keep && !this.timer && this.mic.capturing) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.mic.releaseCapture();
        }, this.graceMs);
      }
      return Promise.resolve();
    }
    this.cancel();
    return this.mic.capturing ? Promise.resolve() : this.mic.reacquireCapture();
  }

  /** The session ends: no release runs any more (the pipeline closes the capture itself). */
  close(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
