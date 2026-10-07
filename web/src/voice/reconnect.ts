// SPDX-License-Identifier: Apache-2.0
/**
 * Connection problems and reconnects (design note 4.5 item 7), pure logic:
 * - the own client rejoins after a full disconnect with backoff for as long as the node's grace period
 *   keeps its seat ([`RejoinSchedule`]);
 * - how another participant is shown ([`participantStatus`]): reconnecting (plug glyph, never speaking),
 *   poor connection (static amber bars), speaking (ring) or idle.
 */
import type { Quality } from "./store";

/** The node's grace period when it does not announce one (`TAVRN_VOICE_RECONNECT_GRACE_SECS` default). */
export const DEFAULT_GRACE_MS = 45_000;
const DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/** When to try the next rejoin after a disconnect at `start`; null once the grace period is over. */
export class RejoinSchedule {
  private attempt = 0;

  constructor(
    private readonly start: number,
    private readonly graceMs: number = DEFAULT_GRACE_MS,
  ) {}

  /** Delay before the next attempt (ms), or null when no attempt fits into the grace period any more. */
  next(now: number): number | null {
    const delay = DELAYS_MS[Math.min(this.attempt, DELAYS_MS.length - 1)]!;
    // The attempt must start (and have a moment to connect) before the node gives up the seat.
    if (now + delay > this.start + this.graceMs - 1_000) return null;
    this.attempt++;
    return delay;
  }

  get attempts(): number {
    return this.attempt;
  }
}

export type ParticipantStatus = "reconnecting" | "poor" | "speaking" | "idle";

/**
 * Display state of a participant: the node's `connection` flag (everybody sees it) or LiveKit's
 * connection quality (participants of the same call) decide; a reconnecting participant never speaks.
 */
export function participantStatus(p: { connection?: string | null; muted?: boolean; server_muted?: boolean }, quality: Quality | undefined, level: number): ParticipantStatus {
  if (p.connection === "reconnecting" || quality === "lost") return "reconnecting";
  if (level > 0 && !p.muted && !p.server_muted) return "speaking";
  if (quality === "poor") return "poor";
  return "idle";
}
