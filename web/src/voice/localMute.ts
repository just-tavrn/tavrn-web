// SPDX-License-Identifier: Apache-2.0
/**
 * Local mute of other participants (issue #124): "Mute for you" silences a person's voice and their stream audio on
 * this device only (`volume.ts` turns it into a zero gain, the session applies it like the volumes); nobody else is
 * told, the node is not involved. Kept per user address in memory for this session, never in storage: after a
 * reload everybody is audible again, so a forgotten mute cannot outlive the day. The UI marks a locally muted
 * participant on the tile and in the member list and the stage header counts them (docs/CLIENT.md "Voice and
 * stream audio").
 */
import { create } from "zustand";

export interface LocalMuteState {
  /** Muted user addresses (without device). */
  muted: Record<string, true>;
}

export const useLocalMute = create<LocalMuteState>(() => ({ muted: {} }));

export const isLocallyMuted = (s: LocalMuteState, address: string): boolean => !!s.muted[address];

export function setLocalMute(address: string, muted: boolean): void {
  useLocalMute.setState((s) => {
    if (!!s.muted[address] === muted) return s;
    const next = { ...s.muted };
    if (muted) next[address] = true;
    else delete next[address];
    return { muted: next };
  });
}

export function toggleLocalMute(address: string): void {
  setLocalMute(address, !isLocallyMuted(useLocalMute.getState(), address));
}

/** How many of `addresses` (a call's participants) are muted for this user. */
export function localMutedCount(s: LocalMuteState, addresses: readonly string[]): number {
  return new Set(addresses.filter((a) => s.muted[a])).size;
}
