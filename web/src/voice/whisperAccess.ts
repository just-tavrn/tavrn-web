// SPDX-License-Identifier: Apache-2.0
import { Permission, hasPermission, type RoomDetail, type TavrnApi, type WhisperReceipt } from "@tavrn/sdk";
import { channelPermissions } from "../lib/channelPermissions";
import { whisperSessionId } from "./whisperTracks";
import type { VoiceTarget } from "./store";

export type { WhisperReceipt, WhisperSession } from "@tavrn/sdk";
export const WHISPER = Permission.WHISPER;
export const startWhisper = (api: TavrnApi, target: VoiceTarget, request: { recipients: string[] } | { reply_to: string }) => api.voice.startWhisper(target.roomId, target.channelId, request);
export const endWhisper = (api: TavrnApi, target: VoiceTarget, id: string) => api.voice.endWhisper(target.roomId, target.channelId, id);
export const receiveWhisper = (api: TavrnApi, target: VoiceTarget, id: string) => api.voice.receiveWhisper(target.roomId, target.channelId, id);

export function whisperAllowed(room: RoomDetail | undefined, channelId: string, userId: string): boolean {
  if (!room || !userId) return false;
  const permissions = channelPermissions(room, channelId, userId, channelId);
  return hasPermission(permissions, Permission.SPEAK | Permission.WHISPER);
}

/** Recheck connection/publication identity after the request; delayed responses never revive old audio. */
export async function verifiedWhisperReceipt(trackName: string, sender: string, request: (id: string) => Promise<WhisperReceipt>, current: () => boolean, now = Date.now): Promise<WhisperReceipt | null> {
  const id = whisperSessionId(trackName);
  if (!id || !current()) return null;
  try {
    const receipt = await request(id);
    const remaining = Date.parse(receipt.expires_at) - now();
    const replyRemaining = Date.parse(receipt.reply_expires_at) - now();
    return current() && receipt.id === id && receipt.sender === sender && remaining > 0 && remaining <= 86_400_000 && replyRemaining > 0 && replyRemaining <= 86_400_000 ? receipt : null;
  } catch { return null; }
}
