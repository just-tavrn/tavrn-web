// SPDX-License-Identifier: Apache-2.0
/**
 * Unicode emoji data for the picker (design note 4.13): `emojibase-data` (MIT), loaded on the first open of a
 * picker as separate chunks (English always for names and keywords, German additionally for German users),
 * plus search, skin tones and the recently used list (local storage, best effort).
 */

/** Groups of emojibase (2 = skin tone components, not shown). */
export const GROUP_KEYS = ["smileys", "people", "components", "nature", "food", "travel", "activities", "objects", "symbols", "flags"] as const;
export const GROUP_ICONS = ["😀", "👋", "🏻", "🐻", "🍔", "✈️", "⚽", "💡", "❤️", "🏳️"];

/** One emoji as the picker needs it. */
export interface EmojiEntry {
  /** The emoji itself (default skin tone). */
  unicode: string;
  /** Name in the UI language. */
  label: string;
  /** Lowercase names in English and the UI language (ranked above keywords). */
  names: string[];
  /** Lowercase keywords in English and the UI language. */
  terms: string[];
  group: number;
  /** Variants by skin tone 1–5 (light … dark), when the emoji has them. */
  skins?: string[];
}

export interface EmojiData {
  entries: EmojiEntry[];
  /** Entries per group, in emojibase order. */
  groups: EmojiEntry[][];
}

interface CompactEmoji {
  unicode: string;
  label: string;
  hexcode: string;
  group?: number;
  order?: number;
  tags?: string[];
  skins?: CompactEmoji[];
}

const TONES = ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"];

/**
 * Emojibase writes some emojis with a variation selector that the fully qualified form does not need
 * (`👍️`); reactions compare strings, so FE0F after code points that are emoji by default is dropped. FE0F
 * after older symbols (`❤️`, `☺️`) stays: there it selects the emoji presentation.
 */
export function normalizeEmoji(s: string): string {
  let out = "";
  let prev = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f && prev >= 0x1f000) continue;
    out += ch;
    prev = cp;
  }
  return out;
}

/** The five single-tone variants of an emoji (multi-person combinations with mixed tones are skipped). */
function toneVariants(e: CompactEmoji): string[] | undefined {
  if (!e.skins?.length) return undefined;
  const out: string[] = [];
  for (const tone of TONES) {
    const v = e.skins.find((s) => {
      const parts = s.hexcode.split("-");
      return parts.includes(tone) && parts.every((p) => !TONES.includes(p) || p === tone);
    });
    if (!v) return undefined;
    out.push(normalizeEmoji(v.unicode));
  }
  return out;
}

/** Builds the picker data from emojibase's compact lists (`local` in the UI language, may be the same). */
export function buildEmojiData(english: CompactEmoji[], local: CompactEmoji[] = english): EmojiData {
  const localByHex = new Map(local.map((e) => [e.hexcode, e]));
  const entries: EmojiEntry[] = [];
  for (const e of [...english].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (e.group === undefined || e.group === 2) continue;
    const l = localByHex.get(e.hexcode) ?? e;
    const names = [...new Set([e.label, l.label].filter(Boolean).map((t) => normalizeQuery(t)))];
    const terms = [...new Set([...(e.tags ?? []), ...(l.tags ?? [])].map((t) => normalizeQuery(t)))].filter((t) => !names.includes(t));
    entries.push({ unicode: normalizeEmoji(e.unicode), label: l.label, names, terms, group: e.group, skins: toneVariants(e) });
  }
  const groups: EmojiEntry[][] = GROUP_KEYS.map(() => []);
  for (const e of entries) groups[e.group]?.push(e);
  return { entries, groups };
}

let english: Promise<CompactEmoji[]> | null = null;
const localized = new Map<string, Promise<CompactEmoji[]>>();

/** Locales with emojibase data the client loads. */
const LOCALES: Record<string, () => Promise<{ default: CompactEmoji[] }>> = {
  de: () => import("emojibase-data/de/compact.json") as unknown as Promise<{ default: CompactEmoji[] }>,
};

/** Loads (once) the data for `locale`; English names and keywords are always included. */
export async function loadEmojiData(locale: string): Promise<EmojiData> {
  english ??= (import("emojibase-data/en/compact.json") as unknown as Promise<{ default: CompactEmoji[] }>).then((m) => m.default);
  const loader = LOCALES[locale];
  let local: Promise<CompactEmoji[]> | undefined;
  if (loader) {
    local = localized.get(locale);
    if (!local) {
      local = loader().then((m) => m.default);
      localized.set(locale, local);
    }
  }
  const [en, loc] = await Promise.all([english, local]);
  return buildEmojiData(en, loc ?? en);
}

/** Normalized search text: lowercase, without diacritics (ä → a), trimmed. */
export function normalizeQuery(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** How well `term` matches `q`: 4 equal, 3 starts with it, 2 a later word starts with it, 1 contains it (≥ 2 characters), 0 not. */
export function matchScore(term: string, q: string): number {
  if (term === q) return 4;
  if (term.startsWith(q)) return 3;
  if (term.split(/[\s:_-]+/).some((w) => w.startsWith(q))) return 2;
  return q.length >= 2 && term.includes(q) ? 1 : 0;
}

/**
 * Entries matching `query`, best first: names before keywords, each equal before word start before
 * contained (queries shorter than two characters only match word starts). Ties keep emojibase order.
 */
export function searchEmojis(data: EmojiData, query: string, limit = 120): EmojiEntry[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const scored: { e: EmojiEntry; score: number }[] = [];
  for (const e of data.entries) {
    let name = 0;
    for (const n of e.names) name = Math.max(name, matchScore(n, q));
    let term = 0;
    for (const t of e.terms) term = Math.max(term, matchScore(t, q));
    const best = Math.max(name * 2, term * 2 - 1);
    // Equal matches: the better name match first.
    if (best > 0) scored.push({ e, score: best * 10 + name });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

/** The variant of an entry for skin tone `tone` (0 = default, 1–5). */
export function withTone(e: EmojiEntry, tone: number): string {
  return tone > 0 && e.skins ? (e.skins[tone - 1] ?? e.unicode) : e.unicode;
}

// ---------------------------------------------------------------- per-device preferences

const RECENT_KEY = "tavrn.emoji.recent";
const TONE_KEY = "tavrn.emoji.tone";
export const RECENT_MAX = 24;

/** Recently used emojis (unicode or custom tokens), newest first; empty when storage is unavailable. */
export function recentEmojis(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 300).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): string[] {
  const next = [emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: not remembered */
  }
  return next;
}

export function skinTone(): number {
  try {
    const n = Number(localStorage.getItem(TONE_KEY) ?? 0);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
  } catch {
    return 0;
  }
}

export function setSkinTone(tone: number) {
  try {
    localStorage.setItem(TONE_KEY, String(tone));
  } catch {
    /* storage unavailable */
  }
}
