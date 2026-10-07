// SPDX-License-Identifier: Apache-2.0
/**
 * Member list sections (design note 4.11): roles with "display separately" (`hoist`) get their own section,
 * ordered by role position (highest first) and then name; an online member appears under their highest
 * hoisted role, everyone else online under "Online", and offline members (also invisible ones) under
 * "Offline". Members are sorted by their shown name.
 */
import type { Member, Role } from "@tavrn/sdk";
import { sortRoles } from "./hierarchy";

export type MemberSection = { kind: "role"; id: string; role: Pick<Role, "id" | "name" | "color" | "position">; members: Member[] } | { kind: "online" | "offline"; id: string; members: Member[] };

export const memberName = (m: Pick<Member, "nickname" | "user">) => m.nickname || m.user.display_name;

export function groupMembers(members: Member[], roles: Pick<Role, "id" | "name" | "color" | "position" | "hoist" | "is_everyone">[], isOnline: (address: string) => boolean, locale?: string): MemberSection[] {
  const hoisted = sortRoles(roles.filter((r) => r.hoist && !r.is_everyone));
  const byRole = new Map<string, Member[]>(hoisted.map((r) => [r.id, []]));
  const online: Member[] = [];
  const offline: Member[] = [];
  for (const m of members) {
    if (!isOnline(m.user.address)) {
      offline.push(m);
      continue;
    }
    const top = hoisted.find((r) => m.roles.includes(r.id));
    if (top) byRole.get(top.id)!.push(m);
    else online.push(m);
  }
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const sorted = (list: Member[]) => list.sort((a, b) => collator.compare(memberName(a), memberName(b)) || a.user.address.localeCompare(b.user.address));
  const sections: MemberSection[] = [];
  for (const r of hoisted) {
    const list = byRole.get(r.id)!;
    if (list.length) sections.push({ kind: "role", id: `role-${r.id}`, role: r, members: sorted(list) });
  }
  if (online.length) sections.push({ kind: "online", id: "online", members: sorted(online) });
  if (offline.length) sections.push({ kind: "offline", id: "offline", members: sorted(offline) });
  return sections;
}

/** The color of a member's name: their highest role with a color. */
export function memberColor(member: Pick<Member, "roles">, roles: Pick<Role, "id" | "name" | "color" | "position" | "is_everyone">[]): string | null {
  return sortRoles(roles.filter((r) => !r.is_everyone && r.color && member.roles.includes(r.id)))[0]?.color ?? null;
}
