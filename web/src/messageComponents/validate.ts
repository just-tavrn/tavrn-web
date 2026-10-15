// SPDX-License-Identifier: Apache-2.0
/**
 * TEMPORARY mirror of the node's component and modal limits (tavrn-protocol/APPLICATIONS.md §5.10) until @tavrn/sdk
 * ships `validateComponents` / `validateModal`; the error paths follow the node's `meta.path`.
 */
import type { ComponentRow, Modal } from "./types";

export type Checked<T> = { ok: true } & T;
export type Refused = { ok: false; path: string };

const MAX_BYTES = 8 * 1024;
const STYLES = new Set(["primary", "secondary", "success", "danger", "link"]);
const SHORTCODE = /^:[a-z0-9_+-]{1,30}:$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, min: number, max: number) => typeof v === "string" && [...v].length >= min && [...v].length <= max;
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).find((k) => !keys.includes(k));

/** One Unicode emoji (a single grapheme with an emoji code point) or a `:shortcode:` of at most 32 characters. */
export function validEmoji(v: unknown): boolean {
  if (typeof v !== "string" || !v || v.length > 32) return false;
  if (SHORTCODE.test(v)) return true;
  const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v)].length : [...v].length;
  return graphemes === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Presentation}/u.test(v);
}

function validUrl(v: unknown): boolean {
  if (typeof v !== "string" || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.host && !u.username && !u.password;
  } catch {
    return false;
  }
}

function checkButton(b: Record<string, unknown>, path: string): string | null {
  const extra = onlyKeys(b, ["type", "style", "label", "emoji", "custom_id", "url", "disabled"]);
  if (extra) return `${path}.${extra}`;
  if (typeof b.style !== "string" || !STYLES.has(b.style)) return `${path}.style`;
  if (b.emoji !== undefined && !validEmoji(b.emoji)) return `${path}.emoji`;
  if (typeof b.label !== "string" || !(str(b.label, 1, 80) || (b.label === "" && b.emoji !== undefined))) return `${path}.label`;
  if (b.disabled !== undefined && typeof b.disabled !== "boolean") return `${path}.disabled`;
  if (b.style === "link") {
    if (b.custom_id !== undefined) return `${path}.custom_id`;
    if (!validUrl(b.url)) return `${path}.url`;
  } else {
    if (!str(b.custom_id, 1, 100)) return `${path}.custom_id`;
    if (b.url !== undefined) return `${path}.url`;
  }
  return null;
}

function checkSelect(s: Record<string, unknown>, path: string): string | null {
  const extra = onlyKeys(s, ["type", "custom_id", "placeholder", "options", "min", "max", "disabled"]);
  if (extra) return `${path}.${extra}`;
  if (!str(s.custom_id, 1, 100)) return `${path}.custom_id`;
  if (s.placeholder !== undefined && !str(s.placeholder, 0, 150)) return `${path}.placeholder`;
  if (!Array.isArray(s.options) || s.options.length < 1 || s.options.length > 25) return `${path}.options`;
  const values = new Set<string>();
  for (const [i, o] of s.options.entries()) {
    const p = `${path}.options[${i}]`;
    if (!isObj(o)) return p;
    const extraO = onlyKeys(o, ["label", "value", "description", "emoji", "default"]);
    if (extraO) return `${p}.${extraO}`;
    if (!str(o.label, 1, 100)) return `${p}.label`;
    if (!str(o.value, 1, 100) || values.has(o.value as string)) return `${p}.value`;
    values.add(o.value as string);
    if (o.description !== undefined && !str(o.description, 0, 100)) return `${p}.description`;
    if (o.emoji !== undefined && !validEmoji(o.emoji)) return `${p}.emoji`;
    if (o.default !== undefined && typeof o.default !== "boolean") return `${p}.default`;
  }
  const min = s.min ?? 1;
  const max = s.max ?? 1;
  if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > 25) return `${path}.min`;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 25 || max < min || max > s.options.length) return `${path}.max`;
  if (s.disabled !== undefined && typeof s.disabled !== "boolean") return `${path}.disabled`;
  return null;
}

/** The node's rules for `text.components`: at most 5 rows of 1–5 buttons or one select, unique ids, 8 KiB. */
export function validateComponents(raw: unknown): Checked<{ rows: ComponentRow[] }> | Refused {
  if (!Array.isArray(raw) || raw.length > 5) return { ok: false, path: "components" };
  if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_BYTES) return { ok: false, path: "components" };
  const ids = new Set<string>();
  for (const [r, row] of raw.entries()) {
    const rp = `components[${r}]`;
    if (!isObj(row) || row.type !== "row") return { ok: false, path: `${rp}.type` };
    const extra = onlyKeys(row, ["type", "components"]);
    if (extra) return { ok: false, path: `${rp}.${extra}` };
    const items = row.components;
    if (!Array.isArray(items) || items.length < 1 || items.length > 5) return { ok: false, path: `${rp}.components` };
    const selects = items.filter((c) => isObj(c) && c.type === "select").length;
    if (selects > 0 && items.length !== 1) return { ok: false, path: `${rp}.components` };
    for (const [i, c] of items.entries()) {
      const cp = `${rp}.components[${i}]`;
      if (!isObj(c)) return { ok: false, path: cp };
      const bad = c.type === "button" ? checkButton(c, cp) : c.type === "select" ? checkSelect(c, cp) : `${cp}.type`;
      if (bad) return { ok: false, path: bad };
      const id = c.custom_id;
      if (typeof id === "string") {
        if (ids.has(id)) return { ok: false, path: `${cp}.custom_id` };
        ids.add(id);
      }
    }
  }
  return { ok: true, rows: raw as ComponentRow[] };
}

/** The node's rules for a modal: title 1–45, 1–5 inputs with unique ids, lengths 0–4000. */
export function validateModal(raw: unknown): Checked<{ modal: Modal }> | Refused {
  if (!isObj(raw)) return { ok: false, path: "modal" };
  const extra = onlyKeys(raw, ["custom_id", "title", "inputs"]);
  if (extra) return { ok: false, path: `modal.${extra}` };
  if (!str(raw.custom_id, 1, 100)) return { ok: false, path: "modal.custom_id" };
  if (!str(raw.title, 1, 45)) return { ok: false, path: "modal.title" };
  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > 5) return { ok: false, path: "modal.inputs" };
  const ids = new Set<string>();
  for (const [i, input] of raw.inputs.entries()) {
    const p = `modal.inputs[${i}]`;
    if (!isObj(input)) return { ok: false, path: p };
    const extraI = onlyKeys(input, ["custom_id", "label", "style", "placeholder", "min_length", "max_length", "required", "value"]);
    if (extraI) return { ok: false, path: `${p}.${extraI}` };
    if (!str(input.custom_id, 1, 100) || ids.has(input.custom_id as string)) return { ok: false, path: `${p}.custom_id` };
    ids.add(input.custom_id as string);
    if (!str(input.label, 1, 45)) return { ok: false, path: `${p}.label` };
    if (input.style !== "short" && input.style !== "paragraph") return { ok: false, path: `${p}.style` };
    if (input.placeholder !== undefined && !str(input.placeholder, 0, 100)) return { ok: false, path: `${p}.placeholder` };
    const min = input.min_length ?? 0;
    const max = input.max_length ?? 4000;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 0 || min > 4000) return { ok: false, path: `${p}.min_length` };
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 4000 || max < min) return { ok: false, path: `${p}.max_length` };
    if (input.required !== undefined && typeof input.required !== "boolean") return { ok: false, path: `${p}.required` };
    if (input.value !== undefined && !str(input.value, 0, 4000)) return { ok: false, path: `${p}.value` };
  }
  return { ok: true, modal: raw as unknown as Modal };
}
