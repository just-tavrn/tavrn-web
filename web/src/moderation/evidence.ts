// SPDX-License-Identifier: Apache-2.0
/**
 * Evidence for reports of encrypted messages (protocol MODERATION.md §1.2): the reporter releases the plaintext of
 * the reported message and up to ten messages before it. Only what this device decrypted can be released; system
 * entries and messages it could not read are left out.
 */
import type { EvidenceEntry, Message } from "@tavrn/sdk";
import { contentAttachments, type Decrypted } from "@tavrn/e2ee";

/** Context messages before the reported one. */
export const EVIDENCE_CONTEXT = 10;

/** A message the reporter may release, with whether it is the reported one. */
export interface EvidenceCandidate extends EvidenceEntry {
  reported: boolean;
  text: string;
  attachments: string[];
}

/** The plaintext of one decrypted message, or null when it cannot be released. */
function entryOf(m: Message, d: Decrypted | undefined): Omit<EvidenceCandidate, "reported"> | null {
  if (!m.encrypted || !d?.ok) return null;
  const c = d.content as { type?: unknown; body?: unknown };
  if (typeof c.type === "string" && c.type.startsWith("system.")) return null;
  const text = typeof c.body === "string" ? c.body.slice(0, 4000) : "";
  const attachments = contentAttachments(d.content, m.attachments)
    .map((a) => (a.name ?? "").slice(0, 255))
    .filter((n) => n.length > 0)
    .slice(0, 10);
  return { message_id: m.id, author: m.author, device_id: m.device_id ?? null, created_at: m.created_at, text, attachments };
}

/**
 * The candidates for a report of `reportedId`: the reported message and up to ten readable messages before it,
 * oldest first. `messages` are newest first (as the API delivers them). Empty when the reported message is not
 * readable here.
 */
export function evidenceCandidates(messages: Message[], decrypted: Record<string, Decrypted>, reportedId: string): EvidenceCandidate[] {
  const index = messages.findIndex((m) => m.id === reportedId);
  if (index < 0) return [];
  const reported = entryOf(messages[index]!, decrypted[reportedId]);
  if (!reported) return [];
  const before: EvidenceCandidate[] = [];
  for (const m of messages.slice(index + 1)) {
    if (before.length >= EVIDENCE_CONTEXT) break;
    const e = entryOf(m, decrypted[m.id]);
    if (e) before.push({ ...e, reported: false });
  }
  return [...before.reverse(), { ...reported, reported: true }];
}

/** The entries to send: the reported one always, context messages only when selected. */
export function selectedEvidence(candidates: EvidenceCandidate[], selected: ReadonlySet<string>): EvidenceEntry[] {
  return candidates.filter((c) => c.reported || selected.has(c.message_id ?? "")).map(({ reported: _reported, ...entry }) => entry);
}
