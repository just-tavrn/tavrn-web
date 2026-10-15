// SPDX-License-Identifier: Apache-2.0
/**
 * What the client accepts as message components (tavrn-protocol/APPLICATIONS.md §5.10). Everything a bot sends is
 * untrusted: in encrypted conversations the node never saw it, so the client runs the node's own checks (the sdk's
 * validators) and renders nothing when a single rule is broken (a half-rendered set could hide a control the bot
 * meant to show); the rest of the message stays.
 */
import { readComponents, validateModal, type Message, type Modal, type Row } from "@tavrn/sdk";

/** The longest error text of a bot shown under its components. */
export const MAX_ERROR_CHARS = 200;

/**
 * Components are meaningful only on messages of an application's bot device (§5.10.1): messages of users and webhooks
 * never show them, even when an encrypted message carries the field (the node cannot refuse it there). `bot` is the
 * list's own knowledge (bot addresses) for messages without `author_kind`.
 */
export function authorKind(m: Pick<Message, "author_kind">, bot: boolean): string | null {
  return m.author_kind ?? (bot ? "bot" : null);
}

/** The rows of a bot's `text` content object when they pass every rule, otherwise null. */
export function componentsOf(content: unknown, kind: string | null): Row[] | null {
  const rows = readComponents(content, kind);
  return rows.length ? rows : null;
}

/** A modal definition from an invocation response when it passes every rule, otherwise null. */
export function modalOf(raw: unknown): Modal | null {
  if (raw === undefined || raw === null) return null;
  return validateModal(raw) === null ? (raw as Modal) : null;
}

/** The bot's error text as shown: one line of at most {@link MAX_ERROR_CHARS} characters. */
export function errorText(text: string | null | undefined): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length > MAX_ERROR_CHARS ? `${one.slice(0, MAX_ERROR_CHARS - 1)}…` : one;
}

/** The values a select starts with: its `default` options, cut to `max`. */
export function defaultValues(options: { value: string; default?: boolean | null }[], max: number): string[] {
  return options.filter((o) => o.default).map((o) => o.value).slice(0, max);
}

