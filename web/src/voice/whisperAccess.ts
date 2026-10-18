// SPDX-License-Identifier: Apache-2.0
import { Permission, hasPermission, inheritedOverrideValue, type InheritedInput, type RoomDetail, type TavrnApi } from "@tavrn/sdk";
import { channelPermissions } from "../lib/channelPermissions";
import type { VoiceTarget } from "./store";

/** VOICE.md whisper2 contract; retained locally until the SDK dependency is repinned. */
export const WHISPER = 1n << 41n;
export interface WhisperSession { id: string; sender: string; recipients: string[]; expires_at: string }
export interface WhisperReceipt { id: string; sender: string; expires_at: string; reply_expires_at: string }
export const isWhisperTrack = (name?: string): boolean => name === "whisper" || !!name?.startsWith("whisper:");
export const whisperSessionId = (name?: string): string | null => name?.startsWith("whisper:") && /^[A-Za-z0-9_-]{1,128}$/.test(name.slice(8)) ? name.slice(8) : null;
const path = (target: VoiceTarget) => `/rooms/${encodeURIComponent(target.roomId)}/channels/${encodeURIComponent(target.channelId)}/voice/whisper`;
export const startWhisper = (api: TavrnApi, target: VoiceTarget, request: { recipients: string[] } | { reply_to: string }) => api.request<WhisperSession>("POST", path(target), request);
export const endWhisper = (api: TavrnApi, target: VoiceTarget, id: string) => api.request<void>("DELETE", `${path(target)}/${encodeURIComponent(id)}`);
export const receiveWhisper = (api: TavrnApi, target: VoiceTarget, id: string) => api.request<WhisperReceipt>("POST", `${path(target)}/${encodeURIComponent(id)}/receive`);

export function whisperAllowed(room: RoomDetail | undefined, channelId: string, userId: string): boolean {
  if (!room || !userId) return false;
  const permissions = channelPermissions(room, channelId, userId, channelId);
  // Older SDKs return their known ALL_PERMISSIONS for owners/administrators.
  if (!hasPermission(permissions, Permission.SPEAK)) return false;
  if (room.is_owner || hasPermission(permissions, Permission.ADMINISTRATOR)) return true;
  if ((Permission as Record<string, bigint>).WHISPER !== undefined) return hasPermission(permissions, WHISPER);
  // The pinned SDK masks unknown channel bits. Evaluate the new bit through a known Voice bit until repinning,
  // clearing that carrier first so existing priority-speaker grants can never grant whisper initiation.
  const carrier = Permission.PRIORITY_SPEAKER;
  const remap = legacyWhisperBits;
  const compatible = { ...room, roles: room.roles.map((r) => ({ ...r, permissions: remap(r.permissions) })), overrides: room.overrides.map((o) => ({ ...o, allow: remap(o.allow), deny: remap(o.deny) })) };
  return hasPermission(channelPermissions(compatible, channelId, userId, channelId), carrier);
}

/** Recheck connection/publication identity after the request; delayed responses never revive old audio. */
export async function verifiedWhisperReceipt(trackName: string, sender: string, request: (id: string) => Promise<WhisperReceipt>, current: () => boolean, now = Date.now): Promise<WhisperReceipt | null> {
  const id = whisperSessionId(trackName);
  if (!id || !current()) return null;
  try {
    const receipt = await request(id);
    const remaining = Date.parse(receipt.expires_at) - now();
    const replyRemaining = Date.parse(receipt.reply_expires_at) - now();
    return current() && receipt.id === id && receipt.sender === sender && remaining > 0 && remaining <= 30_000 && replyRemaining > 0 && replyRemaining <= 120_000 ? receipt : null;
  } catch { return null; }
}

/** Local unpublication is optimistic in LiveKit; wait for the ordered SFU removal acknowledgment. */
export async function confirmedWhisperUnpublish(unpublish: () => Promise<unknown>, listen: (acknowledge: () => void) => () => void): Promise<void> {
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
  const off = listen(acknowledge);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([unpublish(), acknowledged]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Whisper unpublication was not confirmed")), 9000); }),
    ]);
  } finally { off(); clearTimeout(timer); }
}


function legacyWhisperBits(value: bigint | string | number): string {
  const bits = BigInt(value);
  return ((bits & ~Permission.PRIORITY_SPEAKER) | ((bits & WHISPER) ? Permission.PRIORITY_SPEAKER : 0n)).toString();
}

/** Keep channel editor inheritance accurate with the SDK version pinned before whisper2. */
export function whisperInheritance(input: InheritedInput) {
  if ((Permission as Record<string, bigint>).WHISPER !== undefined) return inheritedOverrideValue(input, WHISPER);
  const overrides = (items: InheritedInput["layer_overrides"]) => items.map((o) => ({ ...o, allow: legacyWhisperBits(o.allow), deny: legacyWhisperBits(o.deny) }));
  return inheritedOverrideValue({ ...input, everyone_permissions: legacyWhisperBits(input.everyone_permissions), roles: input.roles.map(([id, bits]) => [id, legacyWhisperBits(bits)]), category_overrides: input.category_overrides && overrides(input.category_overrides), layer_overrides: overrides(input.layer_overrides) }, Permission.PRIORITY_SPEAKER);
}
