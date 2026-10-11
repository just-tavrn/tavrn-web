// SPDX-License-Identifier: Apache-2.0
/**
 * When a plaintext message gets the small "unverified" marker (FEDERATION.md §10.3, PROTOCOL.md §7). People's
 * clients sign their plaintext messages, so a missing or uncheckable signature is worth a note: the hosting node
 * could have written it. Messages the node itself vouches for as application content carry no marker: webhook
 * messages (WEBHOOK badge, APPLICATIONS.md §6.1) and unsigned messages of bots, which post with an app token the
 * node authenticated (APPLICATIONS.md §1.5) and carry the BOT badge; many bots talk to the REST API directly and
 * have no device key to sign with. A bot signature that cannot be checked is the same doubt as for a person, and a
 * person's message without any device id is marked as unsigned.
 */
import { isBotKind, plainMarker, type PlainStatus } from "@tavrn/e2ee";

export interface SignedEnvelope {
  encrypted: boolean;
  device_id?: string | null;
  author_kind?: string;
}

/**
 * The status the marker shows for a plaintext message, or null for no marker. A person's message without a device id
 * is "unsigned" whatever the check says: nothing ties it to a device of the author (the node may have written it).
 */
export function unverifiedStatus(m: SignedEnvelope, status: PlainStatus | undefined, bot: boolean): PlainStatus | null {
  if (m.encrypted || m.author_kind === "webhook") return null;
  if (!m.device_id) return bot || isBotKind(m.author_kind) ? null : "unsigned";
  if (plainMarker(status) !== "unverified") return null;
  return bot && status === "unsigned" ? null : (status ?? null);
}

export function showUnverified(m: SignedEnvelope, status: PlainStatus | undefined, bot: boolean): boolean {
  return unverifiedStatus(m, status, bot) !== null;
}

/**
 * A plaintext message in an end-to-end encrypted conversation (a DM, a group DM or an encrypted channel), except the
 * node's own `system.*` entries: only the node can have put it there, so it is never shown as the author's content
 * (ENCRYPTION.md §5.4), whatever device id or signature it carries.
 */
export function plainInEncrypted(m: { encrypted: boolean; content?: unknown }, conversationEncrypted: boolean): boolean {
  if (!conversationEncrypted || m.encrypted) return false;
  const type = m.content && typeof m.content === "object" ? (m.content as { type?: unknown }).type : undefined;
  return !(typeof type === "string" && type.startsWith("system."));
}
