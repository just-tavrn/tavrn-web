// SPDX-License-Identifier: Apache-2.0
/**
 * Voice frame key bookkeeping (ENCRYPTION.md §5a, VOICE.md §6). Pure, no LiveKit import: the key
 * provider itself lives in `livekit.ts`, which is only loaded when voice is used.
 */

/** LiveKit's key ring holds at most 256 keys; the key index is one byte in every frame trailer. */
export const KEYRING_SIZE = 256;

/** Key index of an MLS epoch: `epoch mod 256`. */
export function voiceKeyIndex(epoch: number): number {
  if (!Number.isInteger(epoch) || epoch < 0) throw new RangeError(`invalid epoch ${epoch}`);
  return epoch % KEYRING_SIZE;
}

/**
 * Which epoch's key was handed to LiveKit last. Epochs only move forward: a late epoch event for an
 * older epoch must not make an old key the sending key again.
 */
export class VoiceKeyRing {
  current: number | null = null;

  needs(epoch: number): boolean {
    return this.current === null || epoch > this.current;
  }

  mark(epoch: number): void {
    if (this.needs(epoch)) this.current = epoch;
  }

  reset(): void {
    this.current = null;
  }
}
