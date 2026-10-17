// SPDX-License-Identifier: Apache-2.0
import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import { editHtml, replaceInText } from "./domText";
import { markMentionsIn, memberPill, mentionPill, type MentionDirectory, type MentionToken } from "./mentionBadges";
import { parseTavrnLink, tavrnLinkPath, type KnownNode } from "./tavrnLinks";

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
 * - **Unicode emojis** are wrapped in `span.emoji-text` (a little larger than the text); a paragraph of 1 … 3 emojis
 *   and nothing else is marked `emoji-only` and shown larger still (tavrn-web#117).
 * - **Mentions are never e-mail links**: `@name@domain` stays text (GFM would autolink `name@domain`), so the mention
 *   pass can mark it; a bare `name@domain` stays a `mailto:` link unless it is a member of the conversation (then a
 *   user pill); explicit `[text](mailto:…)` links stay links.
 * - **tavrn links** (PROTOCOL.md §7h, `lib/tavrnLinks.ts`) of nodes the client knows become in-app links: a bare one
 *   an `a.tavrn-chip` (the message list fills in name and icon), a labelled one keeps its label; profile links
 *   become user pills. Links in code stay literal.
 *
 * The rendering of a text is cached (least recently used entries go first), and so is the final result of the DOM
 * pass after it (emojis and mentions), per emoji map, resolver and mention set. Nothing edits the HTML string after sanitising: link attributes are set in a DOMPurify hook, emoji
 * tokens, room emojis and mentions are applied to DOM text nodes ({@link editHtml}), so message text can never
 * leave an attribute value.
 */

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "span", "img", "div", "button"];
const ALLOWED_ATTR = ["href", "class", "src", "alt", "role", "tabindex", "aria-label", "aria-pressed", "type", "title", "data-code-action", "data-emoji-id", "data-emoji-host", "data-emoji-name"];
/** Attributes whose values are not URLs (with a custom URI pattern DOMPurify checks every other value against it). */
const URI_SAFE = ["type", "tabindex", "aria-pressed", "data-code-action", "data-emoji-id", "data-emoji-host", "data-emoji-name"];
/** Class names our renderers produce; anything else is dropped (highlight.js scopes only with the `hljs-` prefix). */
const CLASS_OK = /^(hljs(-[a-z0-9_]+)*|language-[a-z0-9+#._-]{1,24}|spoiler|codeblock(-[a-z]+)?|emoji-token|autolink|email-auto)$/;

const purify = DOMPurify();
/** True while a message is sanitised (the hooks below apply to messages, not to legal documents). */
let rendering = false;
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  // A token inside an attribute value (a link title, say) stays its literal text.
  if (rendering && data.attrValue.includes("\uE000")) data.attrValue = restoreLiteral(data.attrValue);
  if (data.attrName !== "class") return;
  const kept = data.attrValue.split(/\s+/).filter((c) => CLASS_OK.test(c));
  if (kept.length) data.attrValue = kept.join(" ");
  else data.keepAttr = false;
});
purify.addHook("afterSanitizeAttributes", (node) => {
  if (!rendering || node.nodeName !== "A") return;
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer nofollow");
});

/** Rendered (sanitized) HTML per source text; marked + DOMPurify are the expensive part of a message row. */
export const MARKDOWN_CACHE_SIZE = 1000;
const cache = new Map<string, string>();
/** The result after the emoji and mention pass (rows remount while scrolling a virtualized list). */
const finalCache = new Map<string, string>();

/** Sign-out: the rendered messages of the account (decrypted text among them) leave memory. */
export function forgetRendered(): void {
  cache.clear();
  finalCache.clear();
}

function lruGet(m: Map<string, string>, key: string): string | undefined {
  const hit = m.get(key);
  if (hit !== undefined) {
    m.delete(key);
    m.set(key, hit);
  }
  return hit;
}

function lruSet(m: Map<string, string>, key: string, value: string) {
  m.set(key, value);
  if (m.size > MARKDOWN_CACHE_SIZE) m.delete(m.keys().next().value as string);
}

/** Small numbers naming the identity of an emoji map or resolver (part of the final cache key). */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identity(o: object | undefined): number {
  if (!o) return 0;
  let id = identities.get(o);
  if (!id) {
    id = nextIdentity++;
    identities.set(o, id);
  }
  return id;
}

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
  finalCache.clear();
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
      for (const [key, html] of finalCache) if (html.includes('class="codeblock"')) finalCache.delete(key);
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

/** `@name@domain` (a mention): kept as text so that GFM does not turn `name@domain` into an e-mail link. */
const MENTION_ADDRESS = /^@[A-Za-z0-9][A-Za-z0-9_.-]{0,31}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;
const MENTION_START = /(?:^|[^A-Za-z0-9_@])@[A-Za-z0-9][A-Za-z0-9_.-]{0,31}@[A-Za-z0-9]/;

/** marked's `encodeURI` cleaning of link targets (its default link renderer). */
function cleanHref(href: string): string | null {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

marked.use({
  extensions: [
    {
      name: "mentionAddress",
      level: "inline",
      start(src: string) {
        const m = MENTION_START.exec(src);
        if (!m) return undefined;
        return m.index + m[0].indexOf("@");
      },
      tokenizer(src: string) {
        const m = MENTION_ADDRESS.exec(src);
        return m ? { type: "mentionAddress", raw: m[0], text: m[0] } : undefined;
      },
      renderer(token) {
        // Only letters, digits, `_.-@`: nothing to escape.
        return token.text as string;
      },
    },
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
    // GFM autolinks are marked: a bare URL may become a tavrn chip, a bare address a member's pill (renderMarkdown).
    link(token: Tokens.Link) {
      if (!(token as Tokens.Link & { autolink?: boolean }).autolink) return false;
      const href = cleanHref(token.href);
      const text = this.parser.parseInline(token.tokens);
      if (href === null) return text;
      return `<a href="${href}" class="${href.startsWith("mailto:") ? "email-auto" : "autolink"}">${text}</a>`;
    },
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
  rendering = true;
  let fragment: DocumentFragment;
  try {
    fragment = purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i, ADD_URI_SAFE_ATTR: URI_SAFE, FORBID_TAGS: ["img"], ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  } finally {
    rendering = false;
  }
  // Tokens outside code (code renderers already put the literal text back): a marker the emoji pass turns into an
  // image. The room-emoji pass skips markers, so a token's `:name:` is never mistaken for one of the room's.
  const tokens = current;
  replaceInText(
    fragment,
    PLACEHOLDER,
    (m, doc) => {
      const t = tokens[Number(m[1])];
      if (!t) return doc.createTextNode("");
      const span = doc.createElement("span");
      span.className = "emoji-token";
      span.setAttribute("data-emoji-id", t.id);
      span.setAttribute("data-emoji-host", t.host ?? "");
      span.setAttribute("data-emoji-name", t.name);
      span.textContent = `:${t.name}:`;
      return span;
    },
    () => false,
  );
  const box = (fragment.ownerDocument ?? document).createElement("div");
  box.append(fragment);
  const withTokens = box.innerHTML;
  current = [];
  cache.set(src, withTokens);
  if (cache.size > MARKDOWN_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return withTokens;
}

const TOKEN_ID = new RegExp(`^${ULID}$`);
const TOKEN_HOST = new RegExp(`^(?:${HOST})?$`);
const TOKEN_NAME = new RegExp(`^${NAME}$`);
const ROOM_EMOJI = /:([a-z0-9_]{2,32}):/g;

/** Not inside code, and not inside a token marker (its `:name:` belongs to the token). */
const skipCodeAndTokens = (el: Element) => el.localName === "code" || el.localName === "pre" || el.classList.contains("emoji-token");

function emojiImage(doc: Document, url: string, name: string): HTMLImageElement {
  const img = doc.createElement("img");
  img.className = "emoji";
  img.setAttribute("src", url);
  img.setAttribute("alt", `:${name}:`);
  img.setAttribute("title", `:${name}:`);
  return img;
}

/**
 * A Unicode emoji with emoji presentation (tavrn-web#117): a flag (two regional indicators), a keycap, or a pictograph
 * shown as emoji (`Emoji_Presentation`, or any pictograph with the FE0F selector) with its modifiers, selectors and
 * tag characters, joined by ZWJ into a sequence. Symbols that render as text by default (©, ↔, ♥ without FE0F) and
 * digits stay text.
 */
const EMOJI_UNIT = "(?:\\p{RI}\\p{RI}|[0-9#*]\\uFE0F?\\u20E3|(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\p{Emoji_Modifier}|\\uFE0F|[\\u{E0020}-\\u{E007F}])*)";
const EMOJI = new RegExp(`${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT})*`, "gu");
/** Whether `html` contains an emoji at all: the same pattern, not global (typographic punctuation does not count). */
const HAS_EMOJI = new RegExp(EMOJI.source, "u");
/** At most this many emojis (and nothing else) make an emoji-only message, shown larger. */
export const EMOJI_ONLY_MAX = 3;

function emojiSpan(doc: Document, text: string): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = "emoji-text";
  span.textContent = text;
  return span;
}

/**
 * Marks a paragraph that consists of nothing but 1 … {@link EMOJI_ONLY_MAX} emojis (Unicode spans or custom emoji
 * images) and white space with `emoji-only`; the stylesheet shows them larger.
 */
function markEmojiOnly(root: ParentNode): void {
  const blocks = Array.from(root.childNodes).filter((n) => n.nodeType !== 3 || (n.textContent ?? "").trim() !== "");
  if (blocks.length !== 1 || blocks[0]!.nodeType !== 1 || (blocks[0] as Element).localName !== "p") return;
  const p = blocks[0] as HTMLElement;
  let count = 0;
  for (const n of Array.from(p.childNodes)) {
    if (n.nodeType === 3) {
      if ((n.textContent ?? "").trim() !== "") return;
      continue;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (!((el.localName === "span" && el.classList.contains("emoji-text")) || (el.localName === "img" && el.classList.contains("emoji")))) return;
    count++;
  }
  if (count >= 1 && count <= EMOJI_ONLY_MAX) p.classList.add("emoji-only");
}

function hasRoomEmoji(html: string, emojiUrls: Record<string, string>): boolean {
  for (const m of html.matchAll(ROOM_EMOJI)) if (Object.hasOwn(emojiUrls, m[1]!)) return true;
  return false;
}

/** Mentions to mark in the same pass ({@link markMentionsIn}); `key` names the token set (the cache key). */
export interface MarkdownMentions {
  tokens: readonly MentionToken[];
  key: string;
  botLabel: string;
  /** Members of the conversation: mentions the message does not list become pills too (no notification). */
  directory?: MentionDirectory;
}

/** tavrn links to recognise: the nodes the client knows (`key` names them for the cache) and which one is home. */
export interface MarkdownLinks {
  known: readonly KnownNode[];
  key: string;
  home: (domain: string) => boolean;
}

const NO_EMOJIS: Record<string, string> = {};

/**
 * Links to nodes the client knows become in-app links (PROTOCOL.md §7h): the `href` is the client's own route (a
 * modified click opens it in a new tab of this client), the target is named in data attributes; a bare link becomes
 * `a.tavrn-chip`, a labelled one keeps its label (`a.tavrn-link`), a profile link a user pill.
 */
function markTavrnLinks(root: DocumentFragment, links: MarkdownLinks, mentions: MarkdownMentions | undefined): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (a.closest("code, pre")) continue;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("mailto:")) continue;
    const link = parseTavrnLink(href, links.known);
    if (!link) continue;
    const bare = a.classList.contains("autolink");
    const doc = a.ownerDocument;
    if (link.kind === "user" && bare) {
      a.replaceWith(...mentionPill(doc, `@${link.address}`, mentions?.directory?.kinds.get(link.address) ?? "user", link.address, mentions?.botLabel ?? "BOT"));
      continue;
    }
    for (const name of [...a.getAttributeNames()]) a.removeAttribute(name);
    a.setAttribute("href", tavrnLinkPath(link, links.home));
    a.className = bare ? "tavrn-chip" : "tavrn-link";
    a.setAttribute("data-tavrn-link", link.kind);
    a.setAttribute("data-node", link.node);
    if ("room" in link) a.setAttribute("data-room", link.room);
    if ("channel" in link) a.setAttribute("data-channel", link.channel);
    const target = link.kind === "message" ? link.message : link.kind === "file" ? link.file : link.kind === "invite" ? link.code : link.kind === "user" ? link.address : null;
    if (target) a.setAttribute("data-target", target);
    if (bare) a.setAttribute("data-testid", "tavrn-chip");
  }
}

/** Bare addresses that GFM made e-mail links: a member of the conversation becomes their pill. */
function memberAddresses(root: DocumentFragment, mentions: MarkdownMentions): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a.email-auto"))) {
    const address = (a.getAttribute("href") ?? "").slice("mailto:".length);
    if (a.textContent !== address) continue;
    const nodes = memberPill(a.ownerDocument, address, mentions.directory, mentions.botLabel);
    if (nodes) a.replaceWith(...nodes);
  }
}

/**
 * Markdown → safe HTML. `:name:` tokens become the room's emojis (URLs from `emojiUrls`), `<:name:ID@host>`
 * tokens images from `resolve` (without a resolver, or when it returns null, the name stays as text); `mentions`
 * are marked in the same DOM pass, and `links` to known nodes become in-app links. Pass stable `emojiUrls`,
 * `resolve` and directory (memoized): their identity is part of the cache key of the final result.
 */
export function renderMarkdown(src: string, emojiUrls: Record<string, string> = NO_EMOJIS, resolve?: EmojiResolver, mentions?: MarkdownMentions, links?: MarkdownLinks): string {
  const html = sanitized(src);
  const marks = !!mentions && (mentions.tokens.length > 0 || !!mentions.directory?.kinds.size) && html.includes("@");
  const linked = !!links && links.known.length > 0 && html.includes("<a ");
  const key = `${identity(emojiUrls)}|${identity(resolve)}|${marks ? `${mentions.botLabel}\u0001${mentions.key}\u0001${identity(mentions.directory)}` : ""}|${linked ? links.key : ""}\u0001${src}`;
  const hit = lruGet(finalCache, key);
  if (hit !== undefined) return hit;
  const tokens = !!resolve && html.includes('class="emoji-token"');
  const room = hasRoomEmoji(html, emojiUrls);
  const unicode = HAS_EMOJI.test(html);
  if (!tokens && !room && !unicode && !marks && !linked) return html;
  const out = editHtml(html, (root) => {
    if (linked) markTavrnLinks(root, links, mentions);
    if (tokens) {
      for (const span of root.querySelectorAll<HTMLElement>("span.emoji-token")) {
        const id = span.getAttribute("data-emoji-id") ?? "";
        const host = span.getAttribute("data-emoji-host") ?? "";
        const name = span.getAttribute("data-emoji-name") ?? "";
        if (!TOKEN_ID.test(id) || !TOKEN_HOST.test(host) || !TOKEN_NAME.test(name)) continue;
        const url = resolve!({ id, host: host || null, name });
        if (url) span.replaceWith(emojiImage(span.ownerDocument, url, name));
      }
    }
    if (room) {
      replaceInText(root, ROOM_EMOJI, (m, doc) => (Object.hasOwn(emojiUrls, m[1]!) ? emojiImage(doc, emojiUrls[m[1]!]!, m[1]!) : null), skipCodeAndTokens);
    }
    // Unicode emojis get a span (shown a little larger than the text, tavrn-web#117); then emoji-only paragraphs.
    if (unicode) replaceInText(root, EMOJI, (m, doc) => emojiSpan(doc, m[0]), skipCodeAndTokens);
    markEmojiOnly(root);
    // Mentions last, as the separate pass did: on the text the emoji pass left.
    if (marks) {
      if (mentions.directory?.kinds.size) memberAddresses(root, mentions);
      markMentionsIn(root, mentions.tokens, mentions.botLabel, mentions.directory);
    }
  });
  lruSet(finalCache, key, out);
  return out;
}

// ---------------------------------------------------------------- documents (legal pages)

const DOC_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td"];
/** Links a legal document may keep: http(s), mailto, same-site paths (not `//host` or `/\host`) and fragments. */
export const DOC_SAFE_URL = /^(?:https?:|mailto:|\/(?![/\\])|#)/i;

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
