// SPDX-License-Identifier: Apache-2.0
/**
 * Priority speaker (design note 4.13 item 3, VOICE.md §7a, permission bit 30 `priority_speaker`). While a
 * participant holds the priority key (or the toggle), their client sets the LiveKit participant attribute
 * `priority = "1"`. Receivers lower everybody else to 25 % with an 80 ms ramp, but only after checking
 * that the speaker's room permissions in this channel contain the bit: the attribute alone is a claim that
 * any client could make (a hostile client cannot duck a channel). Light module: no LiveKit import.
 */
import { Permission, hasPermission, type Member } from "@tavrn/sdk";
import { memberChannelPermissions, type RoomPermissionData } from "../lib/memberPermissions";
import type { VoiceTarget } from "./store";

export const PRIORITY_ATTRIBUTE = "priority";
/** Playback gain of everybody else while a verified priority speaker talks. */
export const DUCK_GAIN = 0.25;
/** Length of the gain ramp in both directions. */
export const DUCK_RAMP_MS = 80;

/** Whether LiveKit attributes claim priority. */
export function claimsPriority(attributes: Readonly<Record<string, string>> | undefined): boolean {
  return attributes?.[PRIORITY_ATTRIBUTE] === "1";
}

/** The ducking gain of `identity`: 25 % while another verified priority speaker is active, else 100 %. */
export function duckGain(identity: string, active: ReadonlySet<string>): number {
  if (active.size === 0 || active.has(identity)) return 1;
  return DUCK_GAIN;
}

/**
 * Whether `address` may be a priority speaker in `channelId`: a loaded member of the room whose computed
 * channel permissions contain `priority_speaker`. Unknown members, missing data: no.
 */
export function priorityAllowed(room: RoomPermissionData | undefined, members: Member[] | undefined, channelId: string, address: string, now = Date.now()): boolean {
  if (!room || !members) return false;
  const member = members.find((m) => m.user.address === address);
  if (!member) return false;
  return hasPermission(memberChannelPermissions(room, channelId, member, now), Permission.PRIORITY_SPEAKER);
}

export type PriorityVerifier = (target: VoiceTarget, identity: string) => Promise<boolean>;

let verifier: PriorityVerifier | null = null;

/** Registered by the app (`useVoiceRealtime`), which has the room and member caches. */
export function setPriorityVerifier(fn: PriorityVerifier | null): void {
  verifier = fn;
}

/** Checks a claim; without a registered verifier (calls, tests) nobody is a priority speaker. */
export function verifyPriority(target: VoiceTarget, identity: string): Promise<boolean> {
  if (!verifier || target.call) return Promise.resolve(false);
  return verifier(target, identity).catch(() => false);
}

/**
 * The verified priority speakers of a call: `update` with every attribute change, `remove` when someone
 * leaves. A claim counts only once `verify` confirmed it, and only if it was not withdrawn meanwhile.
 */
export class PriorityTracker {
  private readonly current = new Set<string>();
  private readonly claims = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly verify: (identity: string) => Promise<boolean>,
    private readonly onChange: (active: ReadonlySet<string>) => void,
  ) {}

  get active(): ReadonlySet<string> {
    return this.current;
  }

  async update(identity: string, claimed: boolean): Promise<void> {
    if (!claimed) return this.remove(identity);
    const seq = ++this.seq;
    this.claims.set(identity, seq);
    let ok = false;
    try {
      ok = await this.verify(identity);
    } catch {
      ok = false;
    }
    // Withdrawn or claimed again while the check ran: that newer call decides.
    if (this.claims.get(identity) !== seq) return;
    if (ok && !this.current.has(identity)) {
      this.current.add(identity);
      this.onChange(this.current);
    } else if (!ok && this.current.delete(identity)) {
      this.onChange(this.current);
    }
  }

  remove(identity: string): void {
    this.claims.delete(identity);
    if (this.current.delete(identity)) this.onChange(this.current);
  }

  clear(): void {
    this.claims.clear();
    if (this.current.size === 0) return;
    this.current.clear();
    this.onChange(this.current);
  }
}

/**
 * Ramps an `AudioParam` from its current value to `target` in `DUCK_RAMP_MS` (linear, no clicks), cancelling
 * a ramp that is still running.
 */
export function rampTo(param: AudioParam, target: number, now: number, rampMs = DUCK_RAMP_MS): void {
  const from = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.linearRampToValueAtTime(target, now + rampMs / 1000);
}
