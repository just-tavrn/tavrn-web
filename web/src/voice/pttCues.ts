// SPDX-License-Identifier: Apache-2.0
/**
 * Push-to-talk cues (issue #37): a soft rising tone when push-to-talk opens the microphone, a falling one when it
 * closes (after the release delay, so a key pressed again within it plays nothing), and the same pair, a little higher,
 * for the priority speaker key. They follow the state, not the key events: key repeat, the window and the shell seeing
 * the same key, or a microphone the priority key opened add no tone; the same tone never plays twice within `GAP_MS`
 * (fast taps). They never play while the server keeps the microphone closed (server mute) or the user is muted. The
 * cues play on the output device like every notification sound, never into the microphone track.
 */
import type { Cue } from "./settings";

/** The same tone is not repeated within this time (ms). */
export const GAP_MS = 150;

export class PttCues {
  private open = false;
  /** Who opened the microphone: push-to-talk plays its closing tone, the priority key has its own. */
  private openedBy: "ptt" | "priority" | null = null;
  private prioritySelf = false;
  private readonly last = new Map<Cue, number>();

  constructor(
    private readonly play: (cue: Cue) => void,
    private readonly opts: { allowed: () => boolean; now?: () => number },
  ) {}

  /** The push-to-talk gate of the microphone opened or closed. */
  mic(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open) {
      this.openedBy = this.prioritySelf ? "priority" : "ptt";
      if (this.openedBy === "ptt") this.emit("ptt_on");
      return;
    }
    if (this.openedBy === "ptt") this.emit("ptt_off");
    this.openedBy = null;
  }

  /** The priority speaker key went down or up (accepted by the session). */
  priority(on: boolean): void {
    if (on === this.prioritySelf) return;
    this.prioritySelf = on;
    this.emit(on ? "priority_on" : "priority_off");
  }

  private emit(cue: Cue): void {
    if (!this.opts.allowed()) return;
    const now = (this.opts.now ?? (() => performance.now()))();
    const last = this.last.get(cue);
    if (last !== undefined && now - last < GAP_MS) return;
    this.last.set(cue, now);
    this.play(cue);
  }
}
