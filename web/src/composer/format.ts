// SPDX-License-Identifier: Apache-2.0
/**
 * Formatting actions of the composer's formatting bar and shortcuts (docs/CLIENT.md "The composer"): pure functions
 * from the text and its selection to the new text and selection. Inline formats wrap the selection (or put the
 * caret between empty markers) and toggle off when the selection is already wrapped; line formats prefix every
 * selected line; a code block puts fences on their own lines. Only what the message renderer (`lib/markdown.ts`)
 * shows is offered: no headings (they render as plain text) and no underline (Markdown has none).
 */

export type FormatId = "bold" | "italic" | "strike" | "code" | "codeblock" | "quote" | "bullets" | "numbers" | "link" | "spoiler";

export interface TextState {
  value: string;
  start: number;
  end: number;
}

export interface FormatDef {
  id: FormatId;
  /** Ctrl (Cmd on macOS) plus this key (lowercase), with Shift when `shift`. */
  shortcut?: { key: string; shift: boolean };
}

/** The formats in the bar's order. */
export const FORMATS: readonly FormatDef[] = [
  { id: "bold", shortcut: { key: "b", shift: false } },
  { id: "italic", shortcut: { key: "i", shift: false } },
  { id: "strike", shortcut: { key: "x", shift: true } },
  { id: "code", shortcut: { key: "e", shift: false } },
  { id: "codeblock" },
  { id: "quote" },
  { id: "bullets" },
  { id: "numbers" },
  { id: "link" },
  { id: "spoiler", shortcut: { key: "s", shift: true } },
];

/** The format a key press asks for (Ctrl or Cmd, no Alt), or null. */
export function formatForShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): FormatId | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  return FORMATS.find((f) => f.shortcut && f.shortcut.key === key && f.shortcut.shift === e.shiftKey)?.id ?? null;
}

const INLINE: Partial<Record<FormatId, string>> = { bold: "**", italic: "*", strike: "~~", code: "`", spoiler: "||" };

/** Length of the run of `c` ending right before `i`. */
function runBefore(value: string, i: number, c: string): number {
  let n = 0;
  while (i - n - 1 >= 0 && value[i - n - 1] === c) n++;
  return n;
}

/** Length of the run of `c` starting at `i`. */
function runAfter(value: string, i: number, c: string): number {
  let n = 0;
  while (i + n < value.length && value[i + n] === c) n++;
  return n;
}

/** Whether a run of marker characters contains the marker: asterisks count 1 or 3 as italic, 2 or more as bold. */
function hasMarker(run: number, marker: string): boolean {
  if (marker === "*") return run === 1 || run === 3;
  if (marker === "**") return run >= 2;
  return run >= marker.length;
}

function inline(marker: string, s: TextState): TextState {
  const { value } = s;
  const c = marker[0]!;
  const n = marker.length;
  // Markers right outside the selection (or around the caret): remove them.
  if (hasMarker(runBefore(value, s.start, c), marker) && hasMarker(runAfter(value, s.end, c), marker)) {
    return { value: value.slice(0, s.start - n) + value.slice(s.start, s.end) + value.slice(s.end + n), start: s.start - n, end: s.end - n };
  }
  const selected = value.slice(s.start, s.end);
  // The markers are part of the selection: unwrap it.
  if (selected.length > 2 * n && hasMarker(runAfter(selected, 0, c), marker) && hasMarker(runBefore(selected, selected.length, c), marker)) {
    return { value: value.slice(0, s.start) + selected.slice(n, -n) + value.slice(s.end), start: s.start, end: s.end - 2 * n };
  }
  // White space at the edges stays outside (`** x **` is no emphasis).
  const lead = selected.length - selected.trimStart().length;
  const inner = selected.trim();
  const start = s.start + (inner ? lead : 0);
  const end = inner ? start + inner.length : s.end;
  const text = inner ? inner : selected;
  const before = value.slice(0, start);
  const after = value.slice(end);
  return { value: `${before}${marker}${text}${marker}${after}`, start: start + n, end: start + n + text.length };
}

const PREFIX: Partial<Record<FormatId, RegExp>> = { quote: /^> ?/, bullets: /^[-*+] /, numbers: /^\d+[.)] / };
const LIST = /^(?:[-*+]|\d+[.)]) /;

function lines(id: FormatId, s: TextState): TextState {
  const { value } = s;
  const pattern = PREFIX[id]!;
  const from = value.lastIndexOf("\n", s.start - 1) + 1;
  // A selection that ends at the start of a line does not include that line.
  const last = s.end > s.start && value[s.end - 1] === "\n" ? s.end - 1 : s.end;
  const nl = value.indexOf("\n", last);
  const to = nl < 0 ? value.length : nl;
  const block = value.slice(from, to).split("\n");
  const filled = block.filter((l) => l.trim());
  const remove = filled.length > 0 && filled.every((l) => pattern.test(l));
  let k = 0;
  const next = block.map((l) => {
    if (remove) return l.replace(pattern, "");
    if (!l.trim() && block.length > 1) return l;
    const bare = id === "quote" ? l : l.replace(LIST, "");
    return id === "quote" ? `> ${bare}` : id === "bullets" ? `- ${bare}` : `${++k}. ${bare}`;
  });
  const text = next.join("\n");
  const out = value.slice(0, from) + text + value.slice(to);
  if (s.start === s.end) {
    const caret = Math.max(from, s.start + (next[0]!.length - block[0]!.length));
    return { value: out, start: caret, end: caret };
  }
  return { value: out, start: from, end: from + text.length };
}

function codeBlock(s: TextState): TextState {
  const { value } = s;
  const before = value.slice(0, s.start);
  const after = value.slice(s.end);
  const open = /(^|\n)```[^\n`]*\n$/.exec(before);
  const close = /^\n```(?=\n|$)/.exec(after);
  if (open && close) {
    const cut = open[0].length - open[1]!.length;
    return { value: before.slice(0, before.length - cut) + value.slice(s.start, s.end) + after.slice(close[0].length), start: s.start - cut, end: s.end - cut };
  }
  const selected = value.slice(s.start, s.end);
  const fenced = /^```[^\n`]*\n([\s\S]*)\n```$/.exec(selected);
  if (fenced) return { value: before + fenced[1] + after, start: s.start, end: s.start + fenced[1]!.length };
  const lead = s.start > 0 && value[s.start - 1] !== "\n" ? "\n" : "";
  const trail = s.end < value.length && value[s.end] !== "\n" ? "\n" : "";
  const start = s.start + lead.length + 4;
  return { value: `${before}${lead}\`\`\`\n${selected}\n\`\`\`${trail}${after}`, start, end: start + selected.length };
}

const URL = /^(?:https?:\/\/|mailto:)\S+$/i;
const LINK = /^\[([^\]\n]*)\]\(([^)\s]*)\)$/;

function link(s: TextState): TextState {
  const { value } = s;
  const selected = value.slice(s.start, s.end);
  const before = value.slice(0, s.start);
  const after = value.slice(s.end);
  const existing = LINK.exec(selected);
  if (existing) {
    const text = existing[1] || existing[2]!;
    return { value: before + text + after, start: s.start, end: s.start + text.length };
  }
  if (URL.test(selected.trim())) {
    return { value: `${before}[](${selected.trim()})${after}`, start: s.start + 1, end: s.start + 1 };
  }
  if (!selected) return { value: `${before}[](https://)${after}`, start: s.start + 1, end: s.start + 1 };
  // The label stays; the URL placeholder is selected, so typing or pasting replaces it.
  const urlStart = s.start + selected.length + 3;
  return { value: `${before}[${selected}](https://)${after}`, start: urlStart, end: urlStart + "https://".length };
}

/** Applies a format to the text and its selection. */
export function applyFormat(id: FormatId, s: TextState): TextState {
  const marker = INLINE[id];
  if (marker) return inline(marker, s);
  if (PREFIX[id]) return lines(id, s);
  if (id === "codeblock") return codeBlock(s);
  return link(s);
}
