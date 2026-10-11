// SPDX-License-Identifier: Apache-2.0
/**
 * BOT badges on mentions (tavrn-protocol/APPLICATIONS.md §1.5): in the rendered (sanitized) HTML of a message, `@name`
 * and `@name@domain` of a mentioned bot get a "BOT" badge. Only DOM text nodes outside code are touched (never the
 * HTML string, so attribute values stay intact), and only mentions the message names in its `mentions` list.
 */

import { editHtml, replaceInText } from "./domText";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The spellings of the mentioned bots: `@name@domain` always, `@name` for bots of the conversation's node. */
export function botMentionTokens(mentions: readonly string[] | null | undefined, bots: ReadonlySet<string> | undefined, nodeDomain: string | null): string[] {
  if (!mentions?.length || !bots?.size) return [];
  const lower = new Set([...bots].map((b) => b.toLowerCase()));
  const out: string[] = [];
  for (const address of mentions) {
    const a = address.toLowerCase();
    if (!lower.has(a)) continue;
    out.push(a);
    const at = a.lastIndexOf("@");
    if (nodeDomain && a.slice(at + 1) === nodeDomain.toLowerCase()) out.push(a.slice(0, at));
  }
  // Longest first, so `@bot@node` wins over `@bot`.
  return out.sort((x, y) => y.length - x.length);
}

const inCode = (el: Element) => el.localName === "code" || el.localName === "pre";

/** Wraps the mentions of `tokens` in `html` and appends the badge (label already localized). */
export function markBotMentions(html: string, tokens: readonly string[], label: string): string {
  if (!tokens.length || !html.includes("@")) return html;
  const mention = new RegExp(`(^|[^\\w@])@(${tokens.map(escapeRe).join("|")})(?![\\w@.-]*[\\w])`, "gi");
  return editHtml(html, (root) =>
    replaceInText(
      root,
      mention,
      (m, doc) => {
        const span = doc.createElement("span");
        span.className = "mention";
        span.setAttribute("data-testid", "mention");
        span.setAttribute("data-bot", "true");
        span.textContent = `@${m[2]}`;
        const badge = doc.createElement("span");
        badge.className = "bot-mention-badge";
        badge.setAttribute("data-testid", "bot-badge");
        badge.textContent = label;
        return [...(m[1] ? [doc.createTextNode(m[1])] : []), span, badge];
      },
      inCode,
    ),
  );
}
