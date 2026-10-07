// SPDX-License-Identifier: Apache-2.0
import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";

/**
 * Markdown (subset) → safe HTML for messages. No raw HTML (`<` and `>` are escaped before parsing), links open
 * in a new tab, everything goes through DOMPurify with a fixed allow-list. Extras (design note 4.13):
 *
 * - **Spoilers** `||text||` (inline, also inside quotes and lists): a `span.spoiler` that hides its content
 *   until clicked or activated with Enter/Space ({@link revealSpoiler}).
 * - **Code blocks** with a language label, copy and wrap buttons ({@link handleMarkdownClick}); highlight.js is
 *   loaded on the first block that names a language and the affected renderings are redone
 *   ({@link subscribeMarkdown}); auto-detection only after it is loaded and only among the bundled languages.
 * - **Custom emoji tokens** `<:name:ID>` / `<:name:ID@host>` (PROTOCOL.md §7b): replaced by images through the
 *   caller's resolver; the room's `:name:` emojis as before.
 *
 * The rendering of a text is cached (least recently used entries go first); emoji substitution happens after
 * the cache.
 */

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "span", "img", "div", "button"];
const ALLOWED_ATTR = ["href", "class", "src", "alt", "role", "tabindex", "aria-label", "aria-pressed", "type", "title", "data-code-action", "data-emoji-id", "data-emoji-host", "data-emoji-name"];
/** Attributes whose values are not URLs (with a custom URI pattern DOMPurify checks every other value against it). */
const URI_SAFE = ["type", "tabindex", "aria-pressed", "data-code-action", "data-emoji-id", "data-emoji-host", "data-emoji-name"];
/** Class names our renderers produce; anything else is dropped (highlight.js scopes only with the `hljs-` prefix). */
const CLASS_OK = /^(hljs(-[a-z0-9_]+)*|language-[a-z0-9+#._-]{1,24}|spoiler|codeblock(-[a-z]+)?|emoji-token)$/;

const purify = DOMPurify();
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName !== "class") return;
  const kept = data.attrValue.split(/\s+/).filter((c) => CLASS_OK.test(c));
  if (kept.length) data.attrValue = kept.join(" ");
  else data.keepAttr = false;
});

/** Rendered (sanitized) HTML per source text; marked + DOMPurify are the expensive part of a message row. */
export const MARKDOWN_CACHE_SIZE = 1000;
const cache = new Map<string, string>();

/** UI texts inside rendered messages (set by the views for the current locale). */
export interface MarkdownLabels {
  spoiler: string;
  copy: string;
  wrap: string;
}
let labels: MarkdownLabels = { spoiler: "Spoiler", copy: "Copy", wrap: "Wrap lines" };

/** Sets the localized labels; a change drops the cache. */
export function configureMarkdown(next: MarkdownLabels) {
  if (next.spoiler === labels.spoiler && next.copy === labels.copy && next.wrap === labels.wrap) return;
  labels = next;
  cache.clear();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------- custom emoji tokens

/** A custom emoji named by id (PROTOCOL.md §7b). */
export interface EmojiToken {
  name: string;
  id: string;
  /** The node hosting the emoji; null = the node hosting the conversation. */
  host: string | null;
}

const NAME = "[a-z0-9_]{2,32}";
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = `${LABEL}(?:\\.${LABEL})*(?::[0-9]{1,5})?`;
const TOKEN = new RegExp(`<:(${NAME}):(${ULID})(?:@(${HOST}))?>`, "g");
const TOKEN_EXACT = new RegExp(`^<:(${NAME}):(${ULID})(?:@(${HOST}))?>$`);

/** Parses exactly one token; `null` for anything else (validated by structure, design note 4.13). */
export function parseEmojiToken(s: string): EmojiToken | null {
  const m = TOKEN_EXACT.exec(s);
  if (!m || (m[3] && m[3].length > 259)) return null;
  return { name: m[1]!, id: m[2]!, host: m[3] ?? null };
}

/** All well-formed tokens of a text. */
export function emojiTokens(text: string): EmojiToken[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ name: m[1]!, id: m[2]!, host: m[3] ?? null }));
}

/** The token for an emoji hosted on `emojiNode`, used in a conversation on `conversationNode`. */
export function emojiToken(name: string, id: string, emojiNode: string | null, conversationNode: string): string {
  return emojiNode && emojiNode !== conversationNode ? `<:${name}:${id}@${emojiNode}>` : `<:${name}:${id}>`;
}

/** Image URL of a token; null = cannot be shown (the name is shown instead). */
export type EmojiResolver = (token: EmojiToken) => string | null;

// Tokens are swapped for placeholders (private-use characters marked and DOMPurify leave alone) during one
// synchronous rendering; code renderers put the literal text back.
const PLACEHOLDER = /(\d+)/g;
let current: EmojiToken[] = [];
const literal = (t: EmojiToken) => `<:${t.name}:${t.id}${t.host ? `@${t.host}` : ""}>`;
const restoreLiteral = (s: string) => s.replace(PLACEHOLDER, (_m, i: string) => (current[Number(i)] ? literal(current[Number(i)]!) : ""));

// ---------------------------------------------------------------- highlight.js (lazy)

type Highlighter = typeof import("./highlight");
let highlighter: Highlighter | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** Re-render notifications (highlight.js arrived): returns the unsubscribe function. */
export function subscribeMarkdown(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Changes whenever cached renderings were dropped (for `useSyncExternalStore`). */
export function markdownVersion(): number {
  return version;
}

/** Loads highlight.js once; drops the renderings that contain code blocks and notifies the views. */
export function loadHighlighter(): Promise<void> {
  loading ??= import("./highlight")
    .then((mod) => {
      highlighter = mod;
      for (const [key, html] of cache) if (html.includes('class="codeblock"')) cache.delete(key);
      version++;
      for (const fn of listeners) fn();
    })
    .catch(() => {
      loading = null;
    });
  return loading;
}

function unescapeSource(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const LANG = /^[a-z0-9+#._-]{1,20}$/i;

function renderCode(raw: string, lang: string | undefined): string {
  const code = restoreLiteral(unescapeSource(raw));
  const name = lang && LANG.test(lang) ? lang.toLowerCase() : null;
  if (name && !highlighter) void loadHighlighter();
  const highlighted = highlighter ? highlighter.highlight(code, name) : null;
  const shown = highlighted?.language ?? name;
  const body = highlighted ? highlighted.html : escapeHtml(code);
  const cls = shown ? ` class="hljs language-${escapeAttr(shown)}"` : ' class="hljs"';
  return (
    `<div class="codeblock"><div class="codeblock-bar">` +
    `<span class="codeblock-lang">${shown ? escapeHtml(shown) : ""}</span>` +
    `<button type="button" class="codeblock-btn" data-code-action="wrap" aria-pressed="false" title="${escapeAttr(labels.wrap)}" aria-label="${escapeAttr(labels.wrap)}">↵</button>` +
    `<button type="button" class="codeblock-btn" data-code-action="copy" title="${escapeAttr(labels.copy)}" aria-label="${escapeAttr(labels.copy)}">⧉</button>` +
    `</div><pre tabindex="0"><code${cls}>${body}</code></pre></div>`
  );
}

marked.use({
  extensions: [
    {
      name: "spoiler",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("||");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\|\|(?=\S)([\s\S]*?\S)\|\|/.exec(src);
        if (!m) return undefined;
        return { type: "spoiler", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
      },
      renderer(token) {
        return `<span class="spoiler" role="button" tabindex="0" aria-label="${escapeAttr(labels.spoiler)}">${this.parser.parseInline(token.tokens ?? [])}</span>`;
      },
    },
  ],
  renderer: {
    code(token: Tokens.Code) {
      return renderCode(token.text, token.lang?.trim().split(/\s+/)[0]);
    },
    codespan(token: Tokens.Codespan) {
      // The text arrives escaped by marked; tokens inside code stay literal.
      const text = token.text.replace(/&(?!lt;|gt;)/g, "&amp;");
      return `<code>${text.replace(PLACEHOLDER, (_m, i: string) => (current[Number(i)] ? escapeHtml(literal(current[Number(i)]!)) : ""))}</code>`;
    },
  },
});

/** Markdown → sanitized HTML without emoji substitution, memoized (least recently used entries are dropped). */
function sanitized(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) {
    // Refresh the entry: a Map iterates in insertion order, so the first key is the least recently used.
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  current = [];
  const withPlaceholders = src.replace(/[]/g, "").replace(TOKEN, (_m, name: string, id: string, host: string | undefined) => {
    current.push({ name, id, host: host ?? null });
    return `${current.length - 1}`;
  });
  // Without `<` no tag can form; `>` stays so that blockquotes work.
  const escaped = withPlaceholders.replace(/</g, "&lt;");
  const html = marked.parse(escaped, { async: false }) as string;
  const clean = purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?|mailto|blob):/i, ADD_URI_SAFE_ATTR: URI_SAFE, FORBID_TAGS: ["img"], ALLOW_DATA_ATTR: false });
  const withLinks = clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer nofollow" ');
  // Tokens outside code: a marker the emoji pass turns into an image (text `:name:` with encoded colons, so
  // the room-emoji pass below never mistakes it for one of the room's).
  const withTokens = withLinks.replace(PLACEHOLDER, (_m, i: string) => {
    const t = current[Number(i)];
    if (!t) return "";
    return `<span class="emoji-token" data-emoji-id="${t.id}" data-emoji-host="${t.host ?? ""}" data-emoji-name="${t.name}">&#58;${t.name}&#58;</span>`;
  });
  current = [];
  cache.set(src, withTokens);
  if (cache.size > MARKDOWN_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return withTokens;
}

const TOKEN_SPAN = /<span class="emoji-token" data-emoji-id="([0-9A-Z]{26})" data-emoji-host="([a-z0-9.:-]*)" data-emoji-name="([a-z0-9_]{2,32})">&#58;[a-z0-9_]{2,32}&#58;<\/span>/g;

/**
 * Markdown → safe HTML. `:name:` tokens become the room's emojis (URLs from `emojiUrls`), `<:name:ID@host>`
 * tokens images from `resolve` (without a resolver, or when it returns null, the name stays as text).
 */
export function renderMarkdown(src: string, emojiUrls: Record<string, string> = {}, resolve?: EmojiResolver): string {
  let html = sanitized(src);
  if (resolve && html.includes('class="emoji-token"')) {
    html = html.replace(TOKEN_SPAN, (match, id: string, host: string, name: string) => {
      const url = resolve({ id, host: host || null, name });
      return url ? `<img class="emoji" src="${escapeAttr(url)}" alt=":${name}:" title=":${name}:">` : match;
    });
  }
  if (Object.keys(emojiUrls).length === 0) return html;
  // Only in text nodes, never inside tags or code.
  let inCode = 0;
  return html.replace(/(<\/?(code)?[^>]*>)|:([a-z0-9_]{2,32}):/g, (match, tag: string | undefined, code: string | undefined, name: string | undefined) => {
    if (tag) {
      if (code) inCode += tag.startsWith("</") ? -1 : 1;
      return tag;
    }
    const url = name && inCode === 0 ? emojiUrls[name] : undefined;
    return url ? `<img class="emoji" src="${escapeAttr(url)}" alt=":${name}:" title=":${name}:">` : match;
  });
}

// ---------------------------------------------------------------- documents (legal pages)

const DOC_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const DOC_SAFE_URL = /^(?:https?:|mailto:|\/(?!\/)|#)/i;

/**
 * Markdown of a legal document (design note 4.14) → safe HTML with the message sanitizer: raw HTML is escaped before
 * parsing, images are dropped (no third-party requests), links keep only `http(s):`, `mailto:`, same-site paths and
 * fragments, everything passes DOMPurify with the document allow-list. Headings and tables are kept.
 */
export function renderDocument(src: string): string {
  // Without `<` no tag can form; `>` stays so that blockquotes work.
  const html = marked.parse(src.replace(/</g, "&lt;"), { async: false, gfm: true, breaks: false }) as string;
  return purify.sanitize(html, {
    ALLOWED_TAGS: DOC_TAGS,
    ALLOWED_ATTR: ["href", "title", "align"],
    ALLOWED_URI_REGEXP: DOC_SAFE_URL,
  }) as string;
}

// ---------------------------------------------------------------- interaction (event delegation)

/** Reveals a spoiler element (state per element: it stays revealed until the row is re-created). */
export function revealSpoiler(el: HTMLElement) {
  el.classList.add("revealed");
  el.removeAttribute("role");
  el.removeAttribute("tabindex");
  el.removeAttribute("aria-label");
}

/**
 * Click handler for a container with rendered markdown: spoilers reveal, code block buttons copy or toggle
 * wrapping. Returns true when it handled the event.
 */
export function handleMarkdownClick(target: EventTarget | null, copy: (text: string) => void): boolean {
  if (!(target instanceof Element)) return false;
  const spoiler = target.closest<HTMLElement>("span.spoiler:not(.revealed)");
  if (spoiler) {
    revealSpoiler(spoiler);
    return true;
  }
  const button = target.closest<HTMLElement>("button[data-code-action]");
  const block = button?.closest<HTMLElement>("div.codeblock");
  if (!button || !block) return false;
  if (button.dataset.codeAction === "copy") {
    copy(block.querySelector("pre code")?.textContent ?? "");
  } else {
    const on = block.classList.toggle("codeblock-wrap");
    button.setAttribute("aria-pressed", String(on));
  }
  return true;
}

/** Enter or Space on a focused spoiler reveals it. */
export function handleMarkdownKey(e: { key: string; target: EventTarget | null; preventDefault: () => void }): boolean {
  if (e.key !== "Enter" && e.key !== " ") return false;
  if (!(e.target instanceof HTMLElement) || !e.target.matches("span.spoiler:not(.revealed)")) return false;
  e.preventDefault();
  revealSpoiler(e.target);
  return true;
}

/** Wraps the selection of a text field in `||…||` (composer button, Ctrl+Shift+S); returns the new value and selection. */
export function wrapSpoiler(value: string, start: number, end: number): { value: string; start: number; end: number } {
  const selected = value.slice(start, end);
  const next = `${value.slice(0, start)}||${selected}||${value.slice(end)}`;
  return { value: next, start: start + 2, end: end + 2 };
}
