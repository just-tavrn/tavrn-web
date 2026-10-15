// SPDX-License-Identifier: Apache-2.0
/**
 * One line of a message for previews (reply quotes, pinned messages, announcements, notifications): a poll reads as
 * its question, a text as its body, whitespace collapsed to single spaces and cut to `max` characters with an
 * ellipsis. The callers decide what is readable (decrypted content, never plaintext the node put into an encrypted
 * conversation) and what to show instead.
 */

/** The preview of readable `content`, or null when it has no text (attachments only, an unknown kind). */
export function previewText(content: unknown, max: number): string | null {
  const c = content as { type?: unknown; body?: unknown; question?: unknown } | null;
  if (c?.type === "poll" && typeof c.question === "string") return `📊 ${cut(c.question, max - 3)}`;
  if (!c || typeof c.body !== "string") return null;
  return cut(c.body, max);
}

function cut(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
