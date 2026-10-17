// SPDX-License-Identifier: Apache-2.0
/**
 * Inline autocomplete of the composer (docs/CLIENT.md "The composer"): a provider names its trigger character
 * (`@` for mentions; `#` for channel links later) and turns the typed query into suggestions; the engine finds the
 * trigger at the caret and replaces it with the picked suggestion. A trigger only counts at the start of a word (the
 * start of the text, after white space or an opening bracket or quote) with the caret inside that word, never inside
 * code, so `foo@bar`, addresses in URLs and code stay plain text and typing an `@` is never blocked.
 */

/** One suggestion of a provider. */
export interface Suggestion<T = unknown> {
  /** Unique within one list (the option's id is derived from its index, this is the React key). */
  key: string;
  /** The text that replaces the trigger and the typed query (without the trailing space). */
  insert: string;
  /** What the provider needs to render the row. */
  data: T;
}

/** A source of suggestions for one trigger character. */
export interface CompletionProvider<T = unknown> {
  /** Stable name (`mention`, later `channel`): part of the list's test id. */
  id: string;
  /** One character that opens the provider at the start of a word. */
  trigger: string;
  /** Suggestions for `query` (the text between the trigger and the caret), best first, at most {@link MAX_SUGGESTIONS}. */
  suggest: (query: string) => Suggestion<T>[];
}

/** The trigger found at the caret: `start` is the trigger character, `end` the end of the word it starts. */
export interface Trigger {
  start: number;
  end: number;
  query: string;
}

/** Rows shown at most. */
export const MAX_SUGGESTIONS = 8;
/** A query longer than this is no completion any more (it may contain spaces: role names). */
export const MAX_QUERY = 48;

/** Characters after which a trigger starts a word. */
const OPENERS = /[\s([{"'“„«‹]/;

/** Whether `pos` lies inside a code block (an unclosed ``` before it) or an inline code span on its line. */
export function insideCode(text: string, pos: number): boolean {
  const before = text.slice(0, pos);
  const fences = before.split("```").length - 1;
  if (fences % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf("\n") + 1);
  // Inline code: a run of backticks opens a span that the next run of the same length closes.
  let open = 0;
  for (const run of line.match(/`+/g) ?? []) {
    if (open === 0) open = run.length;
    else if (run.length === open) open = 0;
  }
  return open > 0;
}

/**
 * The trigger `char` the caret is in, or null. The query runs from after the trigger to the caret and may contain
 * spaces (role names; the provider's matching decides whether anything is offered), never a line break; the word
 * end (`end`) covers the non-space characters after the caret, which a completion replaces as well.
 */
export function findTrigger(value: string, caret: number, char: string): Trigger | null {
  if (caret < 1 || caret > value.length) return null;
  const from = Math.max(0, caret - MAX_QUERY - 1);
  let start = -1;
  for (let i = caret - 1; i >= from; i--) {
    const c = value[i]!;
    if (c === "\n") return null;
    if (c === char) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  if (start > 0 && !OPENERS.test(value[start - 1]!)) return null;
  const query = value.slice(start + 1, caret);
  // The query starts right after the trigger: `@ x` is no mention.
  if (/^\s/.test(query)) return null;
  if (insideCode(value, start)) return null;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end]!)) end++;
  return { start, end, query };
}

/** The new value and caret after picking `insert` for `trigger`: one space follows (an existing one is reused). */
export function applyCompletion(value: string, trigger: Trigger, insert: string): { value: string; start: number; end: number } {
  const after = value.slice(trigger.end);
  const spaced = after.startsWith(" ") ? insert : `${insert} `;
  const next = value.slice(0, trigger.start) + spaced + after;
  const caret = trigger.start + insert.length + 1;
  return { value: next, start: caret, end: caret };
}
