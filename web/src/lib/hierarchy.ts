// SPDX-License-Identifier: Apache-2.0
/**
 * Role hierarchy rules of the client (tavrn-protocol/permissions.md "Hierarchy", design note 4.3): roles have a
 * position (`@everyone` = 0); members manage and assign only roles below their own highest one and act
 * only on members whose highest role is lower. Owners outrank everyone. The node enforces the same rules;
 * the client uses them to grey out what would be refused.
 */
import type { Role } from "@tavrn/sdk";

/** The position the user acts with: owners rank above every role. */
export function topPosition(roles: Pick<Role, "id" | "position" | "is_everyone">[], memberRoles: string[], isOwner = false): number {
  if (isOwner) return Number.MAX_SAFE_INTEGER;
  let top = 0;
  for (const r of roles) if (!r.is_everyone && memberRoles.includes(r.id) && r.position > top) top = r.position;
  return top;
}

export interface Rank {
  /** Highest role position (MAX_SAFE_INTEGER for the owner). */
  top: number;
  isOwner: boolean;
}

/** May `actor` moderate `target` (kick, ban, timeout, roles)? Never oneself, never the owner. */
export function outranks(actor: Rank, target: Rank, self: boolean): boolean {
  if (self || target.isOwner) return false;
  if (actor.isOwner) return true;
  return actor.top > target.top;
}

/** May a role at `position` be assigned or edited by someone at `myTop`? */
export function canManageRole(position: number, myTop: number): boolean {
  return position < myTop;
}

/** Sorts roles for display: highest position first, then by name. */
export function sortRoles<T extends Pick<Role, "position" | "name">>(roles: T[]): T[] {
  return [...roles].sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
}

export type ReorderResult = { ok: true; updates: { id: string; position: number }[]; order: string[] } | { ok: false; reason: "hierarchy" | "no_room" | "unknown" };

/**
 * Moves role `movedId` to `targetIndex` of the displayed order (highest first, `@everyone` excluded) and
 * plans the position updates. Roles at or above `myTop` stay where they are and nothing can be moved
 * above them; the movable roles get compact positions below `myTop` (k … 1), and only changed positions
 * are returned. The node bounds positions to 1…10000.
 */
export function planRoleReorder(roles: Pick<Role, "id" | "position" | "name" | "is_everyone">[], movedId: string, targetIndex: number, myTop: number): ReorderResult {
  const list = sortRoles(roles.filter((r) => !r.is_everyone));
  const from = list.findIndex((r) => r.id === movedId);
  if (from < 0) return { ok: false, reason: "unknown" };
  const locked = list.filter((r) => !canManageRole(r.position, myTop)).length;
  if (from < locked) return { ok: false, reason: "hierarchy" };
  const to = Math.max(0, Math.min(targetIndex, list.length - 1));
  if (to < locked) return { ok: false, reason: "hierarchy" };
  const order = [...list];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  const movable = order.slice(locked);
  const k = movable.length;
  const ceiling = Math.min(10_000, myTop - 1);
  if (k > ceiling) return { ok: false, reason: "no_room" };
  const updates: { id: string; position: number }[] = [];
  movable.forEach((r, i) => {
    const position = k - i;
    if (r.position !== position) updates.push({ id: r.id, position });
  });
  return { ok: true, updates, order: order.map((r) => r.id) };
}
