// SPDX-License-Identifier: Apache-2.0
/**
 * Mention pills in rendered messages (design note 4.11, tavrn-web#122) and the BOT badge on mentions of bots
 * (tavrn-protocol/APPLICATIONS.md §1.5). In the rendered (sanitized) HTML of a message, `@name`, `@name@domain`,
 * `@everyone`/`@here` and `@Role` get a `.mention` span with `data-mention` naming the kind: `self` (the reader),
 * `user`, `bot` (plus the badge), `everyone` and `role`. Only DOM text nodes outside code and links are touched (never
 * the HTML string, so attribute values stay intact): the mentions the message carries in its `mentions` list (or
 * `mentions_everyone`), the names of the room's roles, and (without notification semantics, e.g. in a bot's card that
 * carries no `mentions` list) any `@name@domain` or `@name` that is a member of the conversation ({@link MentionDirectory}).
 *
 * Users, bots and roles are clickable (design note 4.11): the pill is a `role="button"` with `tabindex="0"` and names
 * its target in `data-address` (users, bots) or `data-role` (roles); the message list opens the profile card or the
 * role's member list. `@everyone`/`@here` stay plain pills.
 */

import { editHtml, replaceInText } from "./domText";

export type MentionKind = "self" | "user" | "bot" | "everyone" | "role";

/** One spelling the text may contain (without the `@`) and what it is. */
export interface MentionToken {
  token: string;
  kind: MentionKind;
  /** The user's address (users, bots, self); the role's name for roles. */
  target?: string;
}

/**
 * Members of the conversation by address (lowercase) with their kind, for mentions the message does not list (bot
 * cards, edited texts): `domain` is the conversation's node (a bare `@name` means `name@domain`).
 */
export interface MentionDirectory {
  kinds: ReadonlyMap<string, MentionKind>;
  domain: string | null;
}

/** The directory of `members` (addresses): bots as `bot`, the reader as `self`, everyone else `user`. */
export function mentionDirectory(members: readonly string[], opts: { bots?: ReadonlySet<string>; self?: string | null; nodeDomain: string | null }): MentionDirectory {
  const bots = new Set([...(opts.bots ?? [])].map((b) => b.toLowerCase()));
  const self = opts.self?.toLowerCase() ?? null;
  const kinds = new Map<string, MentionKind>();
  for (const address of members) {
    const a = address.toLowerCase();
    kinds.set(a, a === self ? "self" : bots.has(a) ? "bot" : "user");
  }
  return { kinds, domain: opts.nodeDomain?.toLowerCase() ?? null };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The spellings of a message's mentions: `@name@domain` always and `@name` for users of the conversation's node,
 * the reader's own address as `self`, bots as `bot`, `@everyone` and `@here` when the message mentions everyone, and
 * the room's role names as `role` (unless a mentioned member or bot is spelled the same). Longest first, so `@bot@node` wins over `@bot` and `@Raid Leads` over `@Raid`.
 */
export function mentionTokens(
  m: { mentions?: readonly string[] | null; mentions_everyone?: boolean | null },
  opts: { bots?: ReadonlySet<string>; self?: string | null; nodeDomain: string | null; roles?: readonly string[] },
): MentionToken[] {
  const out: MentionToken[] = [];
  const bots = new Set([...(opts.bots ?? [])].map((b) => b.toLowerCase()));
  const self = opts.self?.toLowerCase() ?? null;
  const domain = opts.nodeDomain?.toLowerCase() ?? null;
  for (const address of m.mentions ?? []) {
    const a = address.toLowerCase();
    const kind: MentionKind = a === self ? "self" : bots.has(a) ? "bot" : "user";
    out.push({ token: a, kind, target: a });
    const at = a.lastIndexOf("@");
    if (domain && at > 0 && a.slice(at + 1) === domain) out.push({ token: a.slice(0, at), kind, target: a });
  }
  if (m.mentions_everyone) out.push({ token: "everyone", kind: "everyone" }, { token: "here", kind: "everyone" });
  // A role spelled like a mentioned member or bot (an application's managed role carries its bot's name) is not a
  // token of its own: the explicit mention keeps its kind (and a bot its badge).
  const taken = new Set(out.map((t) => t.token));
  for (const name of opts.roles ?? []) if (name && !name.startsWith("@") && !taken.has(name.toLowerCase())) out.push({ token: name, kind: "role", target: name });
  return out.sort((x, y) => y.token.length - x.token.length);
}

/** A string form of the tokens for memoised row props (`parseMentionTokens` reads it back). */
export function serializeMentionTokens(tokens: readonly MentionToken[]): string {
  return tokens.length ? JSON.stringify(tokens.map((t) => (t.target ? [t.kind, t.token, t.target] : [t.kind, t.token]))) : "";
}

export function parseMentionTokens(s: string): MentionToken[] {
  if (!s) return [];
  try {
    return (JSON.parse(s) as [MentionKind, string, string?][]).map(([kind, token, target]) => (target ? { kind, token, target } : { kind, token }));
  } catch {
    return [];
  }
}

/** The spellings of the mentioned bots (kept for the badge tests): `@name@domain` always, `@name` on the own node. */
export function botMentionTokens(mentions: readonly string[] | null | undefined, bots: ReadonlySet<string> | undefined, nodeDomain: string | null): string[] {
  if (!mentions?.length || !bots?.size) return [];
  return mentionTokens({ mentions }, { bots, nodeDomain })
    .filter((t) => t.kind === "bot")
    .map((t) => t.token);
}

/** Code stays literal; links keep their text (a pill inside a link would be a control inside a control). */
const inCodeOrLink = (el: Element) => el.localName === "code" || el.localName === "pre" || el.localName === "a" || el.classList.contains("mention");

/** A member's name in a passive mention: like a username, ending in a letter, digit or underscore (`@alice.` → `alice`). */
const LOCAL = "[a-z0-9](?:[a-z0-9_.-]{0,30}[a-z0-9_])?";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// The host may be a single label (development nodes such as `localhost`); only directory members match anyway.
const PASSIVE = new RegExp(`(^|[^\\w@])@(${LOCAL})(?:@(${LABEL}(?:\\.${LABEL})*))?(?![\\w@-]|\\.[\\w])`, "gi");

/** The pill of a mention (and the BOT badge after a bot's); `target` is the address or the role name. */
export function mentionPill(doc: Document, text: string, kind: MentionKind, target: string | undefined, botLabel: string): Node[] {
  const span = doc.createElement("span");
  span.className = "mention";
  span.setAttribute("data-testid", "mention");
  span.setAttribute("data-mention", kind);
  if (kind === "bot") span.setAttribute("data-bot", "true");
  if (target && kind !== "everyone") {
    span.setAttribute(kind === "role" ? "data-role" : "data-address", target);
    span.setAttribute("role", "button");
    span.setAttribute("tabindex", "0");
    span.setAttribute("aria-haspopup", "dialog");
  }
  span.textContent = text;
  const nodes: Node[] = [span];
  if (kind === "bot") {
    const badge = doc.createElement("span");
    badge.className = "bot-mention-badge";
    badge.setAttribute("data-testid", "bot-badge");
    badge.textContent = botLabel;
    nodes.push(badge);
  }
  return nodes;
}

/**
 * Wraps the mentions of `tokens` in `html` in `.mention` spans with the kind, and appends the BOT badge (label
 * already localized) to mentions of bots.
 */
export function markMentions(html: string, tokens: readonly MentionToken[], botLabel: string, directory?: MentionDirectory): string {
  if ((!tokens.length && !directory?.kinds.size) || !html.includes("@")) return html;
  return editHtml(html, (root) => markMentionsIn(root, tokens, botLabel, directory));
}

/**
 * {@link markMentions} on an already parsed fragment (one pass together with the markdown's emoji pass): first the
 * message's own tokens (mentions list, roles), then the members of `directory` the text names without listing them.
 */
export function markMentionsIn(root: DocumentFragment, tokens: readonly MentionToken[], botLabel: string, directory?: MentionDirectory): void {
  if (tokens.length) {
    const byToken = new Map(tokens.map((t) => [t.token.toLowerCase(), t]));
    const mention = new RegExp(`(^|[^\\w@])@(${tokens.map((t) => escapeRe(t.token)).join("|")})(?![\\w@.-]*[\\w])`, "gi");
    replaceInText(
      root,
      mention,
      (m, doc) => {
        const t = byToken.get(m[2]!.toLowerCase());
        if (!t) return null;
        return [...(m[1] ? [doc.createTextNode(m[1])] : []), ...mentionPill(doc, `@${m[2]}`, t.kind, t.target, botLabel)];
      },
      inCodeOrLink,
    );
  }
  if (!directory?.kinds.size) return;
  replaceInText(
    root,
    PASSIVE,
    (m, doc) => {
      const local = m[2]!.toLowerCase();
      const host = m[3]?.toLowerCase();
      const address = host ? `${local}@${host}` : directory.domain ? `${local}@${directory.domain}` : null;
      const kind = address ? directory.kinds.get(address) : undefined;
      if (!address || !kind) return null;
      return [...(m[1] ? [doc.createTextNode(m[1])] : []), ...mentionPill(doc, m[0].slice(m[1]!.length), kind, address, botLabel)];
    },
    inCodeOrLink,
  );
}

/** The pill of a member named by a bare address that became an e-mail link (`bob@node.example`), or null. */
export function memberPill(doc: Document, address: string, directory: MentionDirectory | undefined, botLabel: string): Node[] | null {
  const kind = directory?.kinds.get(address.toLowerCase());
  return kind ? mentionPill(doc, address, kind, address.toLowerCase(), botLabel) : null;
}

/** Wraps the mentions of bots (`tokens` from {@link botMentionTokens}) and appends the badge. */
export function markBotMentions(html: string, tokens: readonly string[], label: string): string {
  return markMentions(
    html,
    tokens.map((token) => ({ token, kind: "bot" as const })),
    label,
  );
}
