// SPDX-License-Identifier: Apache-2.0
/**
 * What the client accepts as message components (tavrn-protocol/APPLICATIONS.md §5.10). Everything a bot sends is
 * untrusted: in encrypted conversations the node never saw it, so the client checks the same limits as the node and
 * renders nothing when a single rule is broken (a half-rendered set could hide a control the bot meant to show).
 */
import type { Message } from "@tavrn/sdk";
import type { ComponentRow, Modal } from "./types";
import { validateComponents, validateModal } from "./validate";

/** The longest error text of a bot shown under its components. */
export const MAX_ERROR_CHARS = 200;

/**
 * Components are meaningful only on messages of an application's bot device (§5.10): messages of users and webhooks
 * never show them, even when an encrypted message carries the field (the node cannot refuse it there). `bot` is the
 * list's own knowledge (bot addresses) for messages without `author_kind`.
 */
export function authoredByBot(m: Pick<Message, "author_kind">, bot: boolean): boolean {
  return m.author_kind ? m.author_kind === "bot" : bot;
}

/** The rows of a `text` content object when they pass every rule, otherwise null. */
export function componentsOf(content: unknown): ComponentRow[] | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { type?: unknown; components?: unknown };
  if (c.type !== "text" || c.components === undefined || c.components === null) return null;
  const checked = validateComponents(c.components);
  return checked.ok && checked.rows.length ? checked.rows : null;
}

/** A modal definition from an invocation response when it passes every rule, otherwise null. */
export function modalOf(raw: unknown): Modal | null {
  if (raw === undefined || raw === null) return null;
  const checked = validateModal(raw);
  return checked.ok ? checked.modal : null;
}

/** The bot's error text as shown: one line of at most {@link MAX_ERROR_CHARS} characters. */
export function errorText(text: string | null | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS - 1)}…` : one;
}

/** The values a select starts with: its `default` options, cut to `max`. */
export function defaultValues(options: { value: string; default?: boolean }[], max: number): string[] {
  return options.filter((o) => o.default).map((o) => o.value).slice(0, max);
}

/** The host of a link button's URL (shown before it opens). */
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
