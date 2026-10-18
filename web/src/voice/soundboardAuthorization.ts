// SPDX-License-Identifier: Apache-2.0
/** Receiver authorization for soundboard signals (VOICE.md §8). LiveKit data permission alone is insufficient. */
import { Permission, hasPermission, type Member } from "@tavrn/sdk";
import { memberChannelPermissions, type RoomPermissionData } from "../lib/memberPermissions";
import type { VoiceTarget } from "./store";

/** Unknown rooms, channels or members fail closed. Permissions are recomputed for every signal. */
export function soundboardAllowed(room: RoomPermissionData | undefined, members: Member[] | undefined, channelId: string, address: string, now = Date.now()): boolean {
  const member = members?.find((m) => m.user.address === address);
  if (!room || !member) return false;
  const permissions = memberChannelPermissions(room, channelId, member, now);
  return hasPermission(permissions, Permission.USE_SOUNDBOARD) && hasPermission(permissions, Permission.SPEAK);
}

type SoundboardVerifier = (target: VoiceTarget, identity: string) => boolean;
let verifier: SoundboardVerifier | null = null;

/** The app supplies a synchronous lookup of the current room/member caches; no per-packet fetches. */
export function setSoundboardVerifier(fn: SoundboardVerifier | null): void {
  verifier = fn;
}

/** Synchronous dispatch keeps authorization and the session/participant lifetime check in the same turn. */
export function dispatchSoundboard(target: VoiceTarget, identity: string, isCurrent: () => boolean, dispatch: () => void): void {
  if (!isCurrent() || target.call || !verifier) return;
  try {
    if (verifier(target, identity) && isCurrent()) dispatch();
  } catch {
    // Missing or malformed cached permission data must never authorize a signal.
  }
}
