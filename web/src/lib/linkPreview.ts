// SPDX-License-Identifier: Apache-2.0
/**
 * Link previews in messages (design note 4.13 item 7, PROTOCOL.md §7 `preview`): finding links in a text, the
 * one the sender's client unfurls, validating a stored preview before it is rendered, and keeping the
 * content within the node's size limit.
 */
import { parseEmbed, type Embed } from "./embeds";

/** A link preview as stored in the message content. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  site: string;
  /** `data:image/(webp|png|jpeg);base64,…` */
  image?: string;
}

/** At most this many cards (embeds and the preview) per message. */
export const MAX_CARDS = 3;
const MAX_URLS = 20;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const IMAGE_RE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
/** The node refuses content larger than this (tavrn-node/src/routes/messages.rs `MAX_CONTENT_BYTES`). */
export const MAX_CONTENT_BYTES = 64 * 1024;

/** Trailing punctuation that belongs to the sentence, not to the URL (balanced parentheses stay). Linear. */
function trimUrl(url: string): string {
  let end = url.length;
  let open = 0;
  let close = 0;
  for (const c of url) {
    if (c === "(") open++;
    else if (c === ")") close++;
  }
  for (;;) {
    const last = url[end - 1];
    if (last && ".,;:!?'\"*_~]>".includes(last)) end--;
    else if (last === ")" && open < close) {
      end--;
      close--;
    } else return url.slice(0, end);
  }
}

/** http(s) URLs of a message text in order, without duplicates and code spans/blocks, at most 20. */
export function extractUrls(text: string): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const out: string[] = [];
  for (const m of withoutCode.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length > 2048) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

/** The URL the sender's client unfurls: the first link that is not an embed. */
export function unfurlCandidate(text: string, parent: string): string | null {
  return extractUrls(text).find((u) => !parseEmbed(u, parent)) ?? null;
}

const text = (v: unknown, max: number): string =>
  typeof v === "string"
    ? Array.from(v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim())
        .slice(0, max)
        .join("")
    : "";

/**
 * A stored preview, validated (it comes from another user: the node checks plaintext content, nobody checks
 * encrypted content). Only shown when its URL is one of the links in the text, so a preview can never point
 * somewhere the text does not show.
 */
export function readPreview(raw: unknown, body: string): LinkPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url) || !extractUrls(body).includes(r.url)) return null;
  const title = text(r.title, 300);
  const description = text(r.description, 500);
  if (!title && !description) return null;
  let site = text(r.site, 200);
  if (!site) {
    try {
      site = new URL(r.url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  const image = typeof r.image === "string" && r.image.length <= 60 * 1024 && IMAGE_RE.test(r.image) ? r.image : undefined;
  return { url: r.url, title, description, site, ...(image ? { image } : {}) };
}

/** The node's unfurl answer as the preview stored in the content (`null` if it says nothing). */
export function fromUnfurl(r: { url: string; title: string; description: string; site: string; image_data_url?: string | null }): LinkPreview | null {
  if (!r.title && !r.description) return null;
  return { url: r.url, title: r.title, description: r.description, site: r.site, ...(r.image_data_url ? { image: r.image_data_url } : {}) };
}

/** UTF-8 bytes of the JSON of `content`. */
function jsonBytes(content: unknown): number {
  return new TextEncoder().encode(JSON.stringify(content)).length;
}

/**
 * The preview to store with `content` so that the message stays within the node's limit: encrypted content
 * grows by the MLS framing and by base64 (4/3) on the way to the node, so the image is dropped when it would not
 * fit; the texts alone always fit.
 */
export function fitPreview(content: Record<string, unknown>, preview: LinkPreview, encrypted: boolean): LinkPreview {
  const budget = encrypted ? Math.floor(((MAX_CONTENT_BYTES - 1024) * 3) / 4) - 512 : MAX_CONTENT_BYTES - 512;
  if (!preview.image || jsonBytes({ ...content, preview }) <= budget) return preview;
  const { image: _drop, ...rest } = preview;
  return rest;
}

/** The cards of a message: up to three embeds and the stored preview (if its link is not an embed). */
export function cardsOf(body: string, preview: LinkPreview | null, parent: string, opts: { embeds: boolean; previews: boolean }): { embeds: Embed[]; preview: LinkPreview | null } {
  const urls = extractUrls(body);
  const embeds: Embed[] = [];
  if (opts.embeds) {
    for (const u of urls) {
      const e = parseEmbed(u, parent);
      if (e && !embeds.some((x) => x.embedUrl === e.embedUrl)) embeds.push(e);
      if (embeds.length >= MAX_CARDS) break;
    }
  }
  const shown = opts.previews && preview && embeds.length < MAX_CARDS && !parseEmbed(preview.url, parent) ? preview : null;
  return { embeds, preview: shown };
}
