// SPDX-License-Identifier: Apache-2.0
/**
 * Tokenizer of the composer's styled input (docs/CLIENT.md "The composer"): splits the text into runs with format
 * flags for the highlight layer behind the textarea. The runs always add up to the text exactly (the layer must
 * align character by character). It follows the message renderer (`lib/markdown.ts`: marked with GFM, line breaks,
 * the spoiler extension): fenced code blocks and code spans suppress everything inside, backslash escapes, quotes
 * and list markers per line, links and bare URLs, spoilers, and emphasis with the CommonMark delimiter rules
 * (flanking, intraword underscores, the rule of three) within a paragraph. Mentions of the conversation are marked
 * when their inserted texts are given.
 */

/** Format flags of a run. */
export const F = {
  BOLD: 1,
  ITALIC: 2,
  STRIKE: 4,
  CODE: 8,
  SPOILER: 16,
  /** Markdown syntax (markers, brackets, URLs of links): dimmed. */
  MARK: 32,
  QUOTE: 64,
  LINK: 128,
  MENTION: 256,
  /** Fenced code block (fences included). */
  BLOCK: 512,
} as const;

export interface Run {
  text: string;
  flags: number;
}

/** Longer texts are shown plain (the layer is rebuilt on every input). */
export const STYLED_MAX = 4000;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])(?= |\t|$)/;
const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const URL_AT = /^(?:https?:\/\/|www\.)[^\s<]+/i;
const LINK_AT = /^\[([^[\]\n]*)\]\(([^()\s]*)\)/;
const SPOILER_AT = /^\|\|(?=\S)([\s\S]*?\S)\|\|/;

interface Delim {
  char: string;
  /** Start of the remaining run (closers lose characters at their start). */
  start: number;
  len: number;
  orig: number;
  open: boolean;
  close: boolean;
}

/**
 * Inline formats of one paragraph. `idx` maps positions of the paragraph text `s` (its lines joined with "\n") to
 * positions of the whole text; `flags` and `locked` (characters that are no syntax: code, escapes, URLs) are those
 * of the whole text.
 */
function inline(s: string, idx: number[], flags: Uint16Array, locked: Uint8Array, mentions: readonly string[]) {
  const set = (from: number, to: number, f: number) => {
    for (let i = from; i < to; i++) flags[idx[i]!]! |= f;
  };
  const lock = (from: number, to: number) => {
    for (let i = from; i < to; i++) locked[idx[i]!] = 1;
  };
  const isLocked = (i: number) => locked[idx[i]!] === 1;
  const delims: Delim[] = [];
  let i = 0;
  while (i < s.length) {
    if (isLocked(i)) {
      i++;
      continue;
    }
    const c = s[i]!;
    const prev = i > 0 ? s[i - 1]! : "\n";
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) {
      set(i, i + 1, F.MARK);
      lock(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      // The closing run has exactly the same length.
      let j = i + n;
      let close = -1;
      while (j < s.length) {
        if (s[j] === "`") {
          let m = 1;
          while (s[j + m] === "`") m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m;
        } else j++;
      }
      if (close > 0 && close > i + n) {
        set(i, close + n, F.CODE);
        set(i, i + n, F.MARK);
        set(close, close + n, F.MARK);
        lock(i, close + n);
        i = close + n;
      } else {
        lock(i, i + n);
        i += n;
      }
      continue;
    }
    if (c === "|" && s[i + 1] === "|") {
      const m = SPOILER_AT.exec(s.slice(i));
      if (m) {
        const end = i + m[0].length;
        set(i, i + 2, F.MARK);
        set(end - 2, end, F.MARK);
        set(i + 2, end - 2, F.SPOILER);
        lock(i, i + 2);
        lock(end - 2, end);
        i += 2;
        continue;
      }
    }
    if (c === "[") {
      const m = LINK_AT.exec(s.slice(i));
      if (m) {
        const labelEnd = i + 1 + m[1]!.length;
        const end = i + m[0].length;
        set(i, i + 1, F.MARK);
        set(i + 1, labelEnd, F.LINK);
        set(labelEnd, end, F.MARK);
        lock(i, i + 1);
        lock(labelEnd, end);
        i++;
        continue;
      }
    }
    if ((c === "h" || c === "H" || c === "w" || c === "W") && !/[\p{L}\p{N}]/u.test(prev)) {
      const m = URL_AT.exec(s.slice(i));
      if (m) {
        // Trailing punctuation is not part of a bare URL (GFM autolinks).
        const url = m[0].replace(/[.,:;!?'")\]*_~]+$/, "");
        // A link of the conversation's channels (the composer's `#channel`) gets the pill.
        set(i, i + url.length, mentions.includes(url.toLowerCase()) ? F.MENTION : F.LINK);
        lock(i, i + url.length);
        i += url.length;
        continue;
      }
    }
    if (c === "@" && mentions.length && !/[\w@]/.test(prev)) {
      const rest = s.slice(i).toLowerCase();
      const hit = mentions.find((m) => rest.startsWith(m) && !/[\w@-]/.test(rest[m.length] ?? ""));
      if (hit) {
        set(i, i + hit.length, F.MENTION);
        lock(i, i + hit.length);
        i += hit.length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      let n = 1;
      while (s[i + n] === c && !isLocked(i + n)) n++;
      const before = i > 0 ? s[i - 1]! : " ";
      const after = i + n < s.length ? s[i + n]! : " ";
      const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before));
      const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after));
      let open = left;
      let close = right;
      if (c === "_") {
        open = left && (!right || PUNCT.test(before));
        close = right && (!left || PUNCT.test(after));
      }
      // Strikethrough: one or two tildes (GFM), never more.
      if (c !== "~" || n <= 2) delims.push({ char: c, start: i, len: n, orig: n, open, close });
      i += n;
      continue;
    }
    i++;
  }
  // CommonMark "process emphasis": every closer looks back for the nearest matching opener.
  for (let k = 0; k < delims.length; k++) {
    const d = delims[k]!;
    if (!d.close) continue;
    while (d.len > 0) {
      let j = k - 1;
      for (; j >= 0; j--) {
        const o = delims[j]!;
        if (o.char !== d.char || !o.open || o.len === 0) continue;
        if (d.char === "~") {
          if (o.orig === d.orig) break;
          continue;
        }
        if ((o.close || d.open) && (o.orig + d.orig) % 3 === 0 && !(o.orig % 3 === 0 && d.orig % 3 === 0)) continue;
        break;
      }
      if (j < 0) break;
      const o = delims[j]!;
      const use = d.char === "~" ? d.len : o.len >= 2 && d.len >= 2 ? 2 : 1;
      const contentStart = o.start + o.len;
      set(contentStart - use, contentStart, F.MARK);
      set(d.start, d.start + use, F.MARK);
      set(contentStart, d.start, d.char === "~" ? F.STRIKE : use === 2 ? F.BOLD : F.ITALIC);
      o.len -= use;
      d.start += use;
      d.len -= use;
      // Delimiters between them can no longer match.
      for (let x = j + 1; x < k; x++) delims[x]!.len = 0;
    }
  }
}

/**
 * The runs of `text`; `mentions` are the inserted texts of the conversation's completion candidates (any case):
 * `@…` mentions and the links of the room's channels, both shown as pills.
 */
export function highlight(text: string, mentions: readonly string[] = []): Run[] {
  const n = text.length;
  const flags = new Uint16Array(n);
  const locked = new Uint8Array(n);
  const lowered = [...new Set(mentions.map((m) => m.toLowerCase()))].sort((a, b) => b.length - a.length);
  // Lines with their offsets.
  const lines: { start: number; end: number }[] = [];
  for (let at = 0; ; ) {
    const nl = text.indexOf("\n", at);
    lines.push({ start: at, end: nl < 0 ? n : nl });
    if (nl < 0) break;
    at = nl + 1;
  }
  const mark = (from: number, to: number, f: number) => {
    for (let i = from; i < to; i++) flags[i]! |= f;
  };
  let para: { s: string; idx: number[] } | null = null;
  const flush = () => {
    if (para && para.s) inline(para.s, para.idx, flags, locked, lowered);
    para = null;
  };
  let fence: { char: string; len: number } | null = null;
  let depth = -1;
  for (let li = 0; li < lines.length; li++) {
    const { start, end } = lines[li]!;
    const line = text.slice(start, end);
    // Inside a fenced code block: everything is code, up to and with the closing fence.
    if (fence) {
      const close = FENCE.exec(line);
      const block = li + 1 < lines.length ? end + 1 : end;
      mark(start, block, F.BLOCK);
      locked.fill(1, start, block);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len && !line.slice(close[0].length).trim()) {
        mark(start, end, F.MARK);
        // The line break after the closing fence is not part of the block.
        if (block > end) {
          flags[end]! &= ~F.BLOCK;
          locked[end] = 0;
        }
        fence = null;
      }
      continue;
    }
    // Quote markers (nested ones too), then a list marker.
    let at = 0;
    let quotes = 0;
    for (let m = QUOTE.exec(line); m; m = QUOTE.exec(line.slice(at))) {
      mark(start + at, start + at + m[0].length, F.MARK);
      locked.fill(1, start + at, start + at + m[0].length);
      at += m[0].length;
      quotes++;
    }
    const open = FENCE.exec(line.slice(at));
    if (open) {
      flush();
      fence = { char: open[1]![0]!, len: open[1]!.length };
      const block = li + 1 < lines.length ? end + 1 : end;
      mark(start + at, block, F.BLOCK);
      mark(start + at, end, F.MARK);
      locked.fill(1, start + at, block);
      if (quotes) mark(start, end, F.QUOTE);
      depth = -1;
      continue;
    }
    const list = LIST.exec(line.slice(at));
    if (list) {
      mark(start + at, start + at + list[0].length, F.MARK);
      locked.fill(1, start + at, start + at + list[0].length);
      at += list[0].length;
    }
    if (quotes) mark(start, end, F.QUOTE);
    const content = line.slice(at);
    // A new paragraph: after a blank line, at a list item, when the quote depth changes.
    if (!content.trim() || list || quotes !== depth) flush();
    depth = content.trim() ? quotes : -1;
    if (!content.trim()) continue;
    const current: { s: string; idx: number[] } = para ?? { s: "", idx: [] };
    if (current.s) {
      current.s += "\n";
      current.idx.push(start - 1);
    }
    for (let i = start + at; i < end; i++) {
      current.s += text[i];
      current.idx.push(i);
    }
    para = current;
  }
  flush();
  // Equal neighbours merge into one run.
  const runs: Run[] = [];
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && flags[j] === flags[i]) j++;
    runs.push({ text: text.slice(i, j), flags: flags[i]! });
    i = j;
  }
  return runs;
}
