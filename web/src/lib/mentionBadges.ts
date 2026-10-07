// SPDX-License-Identifier: Apache-2.0
/**
 * BOT badges on mentions (tavrn-protocol/APPLICATIONS.md §1.5): in the rendered (sanitized) HTML of a message, `@name`
 * and `@name@domain` of a mentioned bot get a "BOT" badge. Only text outside tags and code is touched, and only
 * mentions the message names in its `mentions` list.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

/** Wraps the mentions of `tokens` in `html` and appends the badge (label already localized). */
export function markBotMentions(html: string, tokens: readonly string[], label: string): string {
  if (!tokens.length || !html.includes("@")) return html;
  const mention = new RegExp(`(^|[^\\w@])@(${tokens.map(escapeRe).join("|")})(?![\\w@.-]*[\\w])`, "gi");
  const badge = `<span class="bot-mention-badge" data-testid="bot-badge">${escapeHtml(label)}</span>`;
  let inCode = 0;
  return html.replace(/(<\/?(code|pre)?[^>]*>)|([^<]+)/g, (match, tag: string | undefined, code: string | undefined, text: string | undefined) => {
    if (tag) {
      if (code) inCode += tag.startsWith("</") ? -1 : 1;
      return tag;
    }
    if (!text || inCode > 0) return match;
    return text.replace(mention, (_m, before: string, name: string) => `${before}<span class="mention" data-testid="mention" data-bot="true">@${name}</span>${badge}`);
  });
}
