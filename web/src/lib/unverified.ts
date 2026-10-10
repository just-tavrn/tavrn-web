// SPDX-License-Identifier: Apache-2.0
/**
 * When a plaintext message gets the small "unverified" marker (FEDERATION.md §10.3, PROTOCOL.md §7). People's
 * clients sign their plaintext messages, so a missing or uncheckable signature is worth a note: the hosting node
 * could have written it. Messages the node itself vouches for as application content carry no marker: webhook
 * messages (WEBHOOK badge, APPLICATIONS.md §6.1) and unsigned messages of bots, which post with an app token the
 * node authenticated (APPLICATIONS.md §1.5) and carry the BOT badge; many bots talk to the REST API directly and
 * have no device key to sign with. A bot signature that cannot be checked is the same doubt as for a person.
 */
import { plainMarker, type PlainStatus } from "@tavrn/e2ee";

export interface SignedEnvelope {
  encrypted: boolean;
  device_id?: string | null;
  author_kind?: string;
}

export function showUnverified(m: SignedEnvelope, status: PlainStatus | undefined, bot: boolean): boolean {
  if (m.encrypted || !m.device_id || m.author_kind === "webhook") return false;
  if (plainMarker(status) !== "unverified") return false;
  return !(bot && status === "unsigned");
}
