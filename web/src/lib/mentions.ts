// SPDX-License-Identifier: Apache-2.0
/**
 * Mentions of an outgoing message (PROTOCOL.md §7, design note 4.11). `mentions` travels in plaintext in the
 * envelope (also for encrypted messages, so the node can count mentions and filter notifications), so the
 * client extracts them from the text before sending: `@name` (a user of the room's node), `@name@domain`,
 * `@Role` (expanded to the role's members, for mentionable roles or with `mention_everyone`) and
 * `@everyone`/`@here` (only with `mention_everyone`; the node refuses it otherwise). Normalized as the node
 * stores them (lowercase, no duplicates), at most {@link MAX_MENTIONS}.
 */

/** The node's limit (`message.too_many_mentions`). */
export const MAX_MENTIONS = 50;

export interface MentionContext {
  /** Domain of the node hosting the conversation (`@name` means a user of it). */
  domain: string;
  users: { address: string }[];
  roles?: { id: string; name: string; mentionable: boolean; is_everyone: boolean }[];
  /** Role ids per member address. */
  memberRoles?: Record<string, string[]>;
  canMentionEveryone: boolean;
}

export interface Mentions {
  mentions: string[];
  mentions_everyone: boolean;
}

/** Code is not scanned for mentions. */
function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractMentions(body: string, ctx: MentionContext): Mentions {
  const text = withoutCode(body);
  const out: string[] = [];
  const add = (address: string) => {
    const a = address.trim().toLowerCase();
    if (!out.includes(a)) out.push(a);
  };
  const everyone = ctx.canMentionEveryone && /(^|[^\w@])@(everyone|here)\b/i.test(text);
  const known = new Set(ctx.users.map((u) => u.address.toLowerCase()));
  const domain = ctx.domain.toLowerCase();
  // Users first (they are what the writer typed), then members of mentioned roles.
  for (const match of text.matchAll(/(^|[^\w@])@([a-z0-9_.-]+(?:@[a-z0-9.-]+(?::\d+)?)?)/gi)) {
    const token = match[2]!.toLowerCase().replace(/[.]+$/, "");
    const address = token.includes("@") ? token : `${token}@${domain}`;
    if (known.has(address)) add(address);
  }
  const roleMembers: string[] = [];
  for (const role of [...(ctx.roles ?? [])].filter((r) => !r.is_everyone && (r.mentionable || ctx.canMentionEveryone)).sort((a, b) => b.name.length - a.name.length)) {
    if (!new RegExp(`(^|[^\\w@])@${escape(role.name)}(?![\\w])`, "i").test(text)) continue;
    for (const [address, ids] of Object.entries(ctx.memberRoles ?? {})) if (ids.includes(role.id)) roleMembers.push(address);
  }
  for (const a of roleMembers) add(a);
  return { mentions: out.slice(0, MAX_MENTIONS), mentions_everyone: everyone };
}

/** Does a message mention `address` (directly or through @everyone)? */
export function mentionsMe(m: { mentions?: string[] | null; mentions_everyone?: boolean | null }, address: string | undefined): boolean {
  if (!address) return false;
  return !!m.mentions_everyone || !!m.mentions?.some((x) => x.toLowerCase() === address.toLowerCase());
}
