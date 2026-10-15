// SPDX-License-Identifier: Apache-2.0
/**
 * Mention pills in rendered messages (design note 4.11, tavrn-web#122) and the BOT badge on mentions of bots
 * (tavrn-protocol/APPLICATIONS.md §1.5). In the rendered (sanitized) HTML of a message, `@name`, `@name@domain`,
 * `@everyone`/`@here` and `@Role` get a `.mention` span with `data-mention` naming the kind: `self` (the reader),
 * `user`, `bot` (plus the badge), `everyone` and `role`. Only DOM text nodes outside code are touched (never the HTML
 * string, so attribute values stay intact), and only the mentions the message carries in its `mentions` list (or
 * `mentions_everyone`) and the names of the room's roles.
 */

import { editHtml, replaceInText } from "./domText";

export type MentionKind = "self" | "user" | "bot" | "everyone" | "role";

/** One spelling the text may contain (without the `@`) and what it is. */
export interface MentionToken {
  token: string;
  kind: MentionKind;
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
    out.push({ token: a, kind });
    const at = a.lastIndexOf("@");
    if (domain && at > 0 && a.slice(at + 1) === domain) out.push({ token: a.slice(0, at), kind });
  }
  if (m.mentions_everyone) out.push({ token: "everyone", kind: "everyone" }, { token: "here", kind: "everyone" });
  // A role spelled like a mentioned member or bot (an application's managed role carries its bot's name) is not a
  // token of its own: the explicit mention keeps its kind (and a bot its badge).
  const taken = new Set(out.map((t) => t.token));
  for (const name of opts.roles ?? []) if (name && !name.startsWith("@") && !taken.has(name.toLowerCase())) out.push({ token: name, kind: "role" });
  return out.sort((x, y) => y.token.length - x.token.length);
}

/** A string form of the tokens for memoised row props (`parseMentionTokens` reads it back). */
export function serializeMentionTokens(tokens: readonly MentionToken[]): string {
  return tokens.length ? JSON.stringify(tokens.map((t) => [t.kind, t.token])) : "";
}

export function parseMentionTokens(s: string): MentionToken[] {
  if (!s) return [];
  try {
    return (JSON.parse(s) as [MentionKind, string][]).map(([kind, token]) => ({ kind, token }));
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

const inCode = (el: Element) => el.localName === "code" || el.localName === "pre";

/**
 * Wraps the mentions of `tokens` in `html` in `.mention` spans with the kind, and appends the BOT badge (label
 * already localized) to mentions of bots.
 */
export function markMentions(html: string, tokens: readonly MentionToken[], botLabel: string): string {
  if (!tokens.length || !html.includes("@")) return html;
  const kinds = new Map(tokens.map((t) => [t.token.toLowerCase(), t.kind]));
  const mention = new RegExp(`(^|[^\\w@])@(${tokens.map((t) => escapeRe(t.token)).join("|")})(?![\\w@.-]*[\\w])`, "gi");
  return editHtml(html, (root) =>
    replaceInText(
      root,
      mention,
      (m, doc) => {
        const kind = kinds.get(m[2]!.toLowerCase());
        if (!kind) return null;
        const span = doc.createElement("span");
        span.className = "mention";
        span.setAttribute("data-testid", "mention");
        span.setAttribute("data-mention", kind);
        if (kind === "bot") span.setAttribute("data-bot", "true");
        span.textContent = `@${m[2]}`;
        const nodes: Node[] = [...(m[1] ? [doc.createTextNode(m[1])] : []), span];
        if (kind === "bot") {
          const badge = doc.createElement("span");
          badge.className = "bot-mention-badge";
          badge.setAttribute("data-testid", "bot-badge");
          badge.textContent = botLabel;
          nodes.push(badge);
        }
        return nodes;
      },
      inCode,
    ),
  );
}

/** Wraps the mentions of bots (`tokens` from {@link botMentionTokens}) and appends the badge. */
export function markBotMentions(html: string, tokens: readonly string[], label: string): string {
  return markMentions(
    html,
    tokens.map((token) => ({ token, kind: "bot" as const })),
    label,
  );
}
