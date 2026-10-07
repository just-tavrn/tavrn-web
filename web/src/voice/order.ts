// SPDX-License-Identifier: Apache-2.0
/**
 * Order and look of voice participants (design note 4.13 item 3): sorted by their highest role position, then
 * by the shown name (`Intl.Collator`); names and colours like the member list (nickname, then display name,
 * the address's local part only for people the member list does not know; the colour of the highest role
 * with a colour). The stage keeps its order while the membership stays the same, so tiles never jump while
 * someone speaks or changes a flag.
 */
import type { Member, Role } from "@tavrn/sdk";
import { topPosition } from "../lib/hierarchy";
import { memberColor, memberName } from "../lib/memberGroups";

export interface ParticipantLook {
  name: string;
  color: string | null;
  /** Highest role position (0 = only @everyone, or unknown). */
  top: number;
}

/** `alice` of `alice@node.example`. */
export function localPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

/** Look of every member by address. */
export function memberLooks(members: Member[] | undefined, roles: Pick<Role, "id" | "name" | "color" | "position" | "is_everyone">[]): Map<string, ParticipantLook> {
  const out = new Map<string, ParticipantLook>();
  for (const m of members ?? []) out.set(m.user.address, { name: memberName(m) || localPart(m.user.address), color: memberColor(m, roles), top: topPosition(roles, m.roles) });
  return out;
}

export function lookOf(looks: Map<string, ParticipantLook>, address: string): ParticipantLook {
  return looks.get(address) ?? { name: localPart(address), color: null, top: 0 };
}

/** Sorts by highest role (descending), then name, then `key` (stable for equal names). */
export function sortByRank<T>(items: readonly T[], look: (item: T) => ParticipantLook, key: (item: T) => string, locale?: string): T[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return items
    .map((item) => ({ item, look: look(item), key: key(item) }))
    .sort((a, b) => b.look.top - a.look.top || collator.compare(a.look.name, b.look.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.item);
}

/**
 * The stage order: `previous` as long as it holds exactly the same identities, otherwise `sorted()` (a new
 * sort only when somebody joins or leaves).
 */
export function stableOrder(previous: readonly string[] | null, ids: readonly string[], sorted: () => string[]): string[] {
  if (previous && previous.length === ids.length) {
    const set = new Set(ids);
    if (previous.every((id) => set.has(id))) return previous as string[];
  }
  return sorted();
}
