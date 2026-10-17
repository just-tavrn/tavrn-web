// SPDX-License-Identifier: Apache-2.0
/**
 * The mention provider of the composer's autocomplete (docs/CLIENT.md "The composer"). Candidates are only who is
 * in this conversation: in a room channel the members who can view the channel (the room's member list, filtered
 * with the same permission rules as the node), its mentionable roles (every role for members with
 * `mention_everyone`) and `@everyone`/`@here` with that right; in DMs and group DMs the participants. Never the
 * node's user directory. The inserted text is what `lib/mentions.ts` `extractMentions` recognises: `@name` for a
 * user of the conversation's node, `@name@domain` for anyone else, `@Role Name` for a role.
 */
import { Permission, hasPermission, isBotKind, type Member, type Role, type User } from "@tavrn/sdk";
import { fuzzyScore } from "../commands/fuzzy";
import { mentionToken } from "../lib/composerBridge";
import { memberChannelPermissions, type RoomPermissionData } from "../lib/memberPermissions";
import { memberName } from "../lib/memberGroups";
import { safeColor, stripBidi } from "../lib/untrusted";
import { MAX_SUGGESTIONS, type CompletionProvider, type Suggestion } from "./autocomplete";

/** The avatar fields of a user (the row shows the avatar). */
export type MentionAvatar = Pick<User, "address" | "display_name" | "avatar" | "avatar_still">;

export interface MentionCandidate {
  kind: "user" | "role" | "everyone";
  /** The address (users), `role:<id>` (roles), `everyone` or `here`. */
  key: string;
  /** Inserted text without the trailing space. */
  insert: string;
  /** Shown name: nickname or display name, the role's name, `@everyone`/`@here`. */
  name: string;
  /** Matched besides the name: the username. */
  username?: string;
  /** The user's node when it is not the conversation's node (shown next to the name). */
  remote?: string | null;
  bot?: boolean;
  self?: boolean;
  avatar?: MentionAvatar;
  /** A role's colour (`#rrggbb` only). */
  color?: string | null;
}

function userCandidate(u: Pick<User, "address" | "username" | "domain" | "display_name" | "kind" | "avatar" | "avatar_still">, name: string, domain: string, self: string | undefined): MentionCandidate {
  const remote = u.domain.toLowerCase() === domain.toLowerCase() ? null : u.domain;
  return {
    kind: "user",
    key: u.address,
    insert: mentionToken(u.address, domain).trimEnd(),
    name: stripBidi(name) || u.username,
    username: u.username,
    remote,
    bot: isBotKind(u.kind),
    self: !!self && u.address.toLowerCase() === self.toLowerCase(),
    avatar: { address: u.address, display_name: u.display_name, avatar: u.avatar, avatar_still: u.avatar_still },
  };
}

function roleCandidates(roles: Pick<Role, "id" | "name" | "mentionable" | "is_everyone" | "color">[], canMentionEveryone: boolean): MentionCandidate[] {
  const out: MentionCandidate[] = roles
    .filter((r) => !r.is_everyone && r.name.trim() && (r.mentionable || canMentionEveryone))
    .map((r) => ({ kind: "role", key: `role:${r.id}`, insert: `@${r.name}`, name: r.name, color: safeColor(r.color) }));
  if (canMentionEveryone) out.push({ kind: "everyone", key: "everyone", insert: "@everyone", name: "@everyone" }, { kind: "everyone", key: "here", insert: "@here", name: "@here" });
  return out;
}

/** Room channels: members who can view `channelId`, mentionable roles, `@everyone`/`@here` with the right. */
export function channelMentionCandidates(src: {
  room: RoomPermissionData & { roles: Pick<Role, "id" | "name" | "mentionable" | "is_everyone" | "color" | "permissions">[] };
  channelId: string;
  members: Member[];
  /** The domain of the node hosting the conversation. */
  domain: string;
  /** The own address (listed last). */
  self?: string;
  canMentionEveryone: boolean;
}): MentionCandidate[] {
  const users = src.members
    .filter((m) => !m.user.deleted && hasPermission(memberChannelPermissions(src.room, src.channelId, m), Permission.VIEW_CHANNEL))
    .map((m) => userCandidate(m.user, memberName(m), src.domain, src.self));
  return [...users, ...roleCandidates(src.room.roles, src.canMentionEveryone)];
}

/** DMs and group DMs: the participants. */
export function directMentionCandidates(src: { people: Pick<User, "address" | "username" | "domain" | "display_name" | "kind" | "avatar" | "avatar_still">[]; domain: string; self?: string }): MentionCandidate[] {
  return src.people.map((u) => userCandidate(u, u.display_name, src.domain, src.self));
}

const RANK = { user: 0, role: 1, everyone: 2 } as const;

function score(c: MentionCandidate, query: string): number {
  // With a space only prefixes count (role names): "@bob und " is no longer a mention being typed.
  if (/\s/.test(query)) return c.name.toLowerCase().startsWith(query.toLowerCase()) ? 800 : -1;
  const q = query.replace(/^@/, "");
  const names = [c.name.replace(/^@/, ""), c.username ?? ""].filter(Boolean);
  return Math.max(...names.map((n) => fuzzyScore(q, n)));
}

/** The candidates matching `query`, best first, the own user last, at most {@link MAX_SUGGESTIONS}. */
export function matchMentions(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  return candidates
    .map((c, index) => ({ c, index, s: score(c, query) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => Number(!!a.c.self) - Number(!!b.c.self) || b.s - a.s || RANK[a.c.kind] - RANK[b.c.kind] || a.index - b.index)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.c);
}

/** The `@` provider over a fixed candidate list. */
export function mentionProvider(candidates: MentionCandidate[]): CompletionProvider<MentionCandidate> {
  return {
    id: "mention",
    trigger: "@",
    suggest: (query): Suggestion<MentionCandidate>[] => matchMentions(candidates, query).map((c) => ({ key: c.key, insert: c.insert, data: c })),
  };
}
