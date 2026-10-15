// SPDX-License-Identifier: Apache-2.0
/**
 * Reordering channels and categories in the room settings (docs/CLIENT.md "Room settings"): pure planners that turn
 * a move into the PATCH requests that save it. Positions are per group (a category, or the channels without one); the
 * node and the room cache order by `position, id`, so every movable member of a touched group gets a distinct position
 * 0 … n-1 and only the changed ones are sent. The welcome channel (kind `system`) and pinned channels (negative
 * position) are fixed: they keep their place and are never renumbered.
 */
import type { Category, Channel } from "@tavrn/sdk";

type OrderChannel = Pick<Channel, "id" | "kind" | "position" | "category_id">;
type OrderCategory = Pick<Category, "id" | "position">;
/** The parts of a room detail the planners read. */
export interface RoomOrder {
  channels: readonly OrderChannel[];
  categories: readonly OrderCategory[];
}

/** One PATCH: the new position and, for the moved channel only when it changes, the new category. */
export interface OrderUpdate {
  id: string;
  position: number;
  category_id?: string | null;
}

export type OrderPlan = { ok: true; updates: OrderUpdate[] } | { ok: false; reason: "fixed" | "unknown" | "invalid_target" };

const byPosition = (a: { id: string; position: number }, b: { id: string; position: number }) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The welcome channel and pinned channels stay where the node put them. */
export const isFixedChannel = (c: Pick<Channel, "kind" | "position">): boolean => c.kind === "system" || c.position < 0;

const groupOf = (c: Pick<Channel, "category_id">): string | null => c.category_id ?? null;

/** The movable channels of a group in display order. */
export function channelGroup<T extends OrderChannel>(room: { channels: readonly T[] }, categoryId: string | null): T[] {
  return room.channels.filter((c) => groupOf(c) === categoryId && !isFixedChannel(c)).sort(byPosition);
}

/** Positions 0 … n-1 for `order`; only the entries whose position changes. */
function renumber(order: readonly { id: string; position: number }[]): OrderUpdate[] {
  return order.flatMap((x, i) => (x.position === i ? [] : [{ id: x.id, position: i }]));
}

/** Its own place: the order does not change, so nothing is renumbered (even when the positions have gaps). */
const sameOrder = (a: readonly { id: string }[], b: readonly { id: string }[]) => a.length === b.length && a.every((x, i) => x.id === b[i]!.id);

const clamp = (index: number, max: number) => (Number.isNaN(index) ? max : Math.max(0, Math.min(Math.trunc(index), max)));

/**
 * Moves channel `channelId` into the group `targetCategoryId` (null: no category) at `targetIndex` of the group's
 * resulting order (clamped; `Infinity` appends). The moved channel comes first in `updates` (with `category_id` when
 * it changes), then the rest of the target group, then the group it left. Its own place is a no-op.
 */
export function planChannelMove(room: RoomOrder, channelId: string, targetCategoryId: string | null, targetIndex: number): OrderPlan {
  const moved = room.channels.find((c) => c.id === channelId);
  if (!moved) return { ok: false, reason: "unknown" };
  if (isFixedChannel(moved)) return { ok: false, reason: "fixed" };
  if (targetCategoryId !== null && !room.categories.some((c) => c.id === targetCategoryId)) return { ok: false, reason: "unknown" };
  const from = groupOf(moved);
  const target = channelGroup(room, targetCategoryId).filter((c) => c.id !== channelId);
  const order = [...target];
  order.splice(clamp(targetIndex, target.length), 0, moved);
  const updates = renumber(order);
  const changesGroup = from !== targetCategoryId;
  if (changesGroup) {
    const own = updates.find((u) => u.id === channelId);
    const entry: OrderUpdate = { id: channelId, position: own?.position ?? moved.position, category_id: targetCategoryId };
    const rest = updates.filter((u) => u.id !== channelId);
    return { ok: true, updates: [entry, ...rest, ...renumber(channelGroup(room, from).filter((c) => c.id !== channelId))] };
  }
  if (sameOrder(order, channelGroup(room, from))) return { ok: true, updates: [] };
  const own = updates.filter((u) => u.id === channelId);
  return { ok: true, updates: [...own, ...updates.filter((u) => u.id !== channelId)] };
}

/** Moves category `categoryId` to `targetIndex` of the resulting category order (clamped); its own place is a no-op. */
export function planCategoryMove(room: RoomOrder, categoryId: string, targetIndex: number): OrderPlan {
  const list = [...room.categories].sort(byPosition);
  const from = list.findIndex((c) => c.id === categoryId);
  if (from < 0) return { ok: false, reason: "unknown" };
  const order = list.filter((c) => c.id !== categoryId);
  order.splice(clamp(targetIndex, order.length), 0, list[from]!);
  if (sameOrder(order, list)) return { ok: true, updates: [] };
  const updates = renumber(order);
  return { ok: true, updates: [...updates.filter((u) => u.id === categoryId), ...updates.filter((u) => u.id !== categoryId)] };
}

/** What is being dragged. */
export type DragItem = { type: "channel" | "category"; id: string };

/**
 * Where it is dropped: on a channel row (that row's place), on a category header (a channel goes into the category at
 * its end; a category takes that category's place) or on the end of a group (`null`: the channels without category).
 */
export type DropTarget = { type: "channel"; id: string } | { type: "category"; id: string } | { type: "group_end"; categoryId: string | null };

/** Plans a drag and drop. A category never goes into a category or between channels. */
export function planDrop(room: RoomOrder, item: DragItem, target: DropTarget): OrderPlan {
  if (item.type === "category") {
    if (target.type !== "category") return { ok: false, reason: "invalid_target" };
    const index = [...room.categories].sort(byPosition).findIndex((c) => c.id === target.id);
    return index < 0 ? { ok: false, reason: "unknown" } : planCategoryMove(room, item.id, index);
  }
  if (target.type === "category") return planChannelMove(room, item.id, target.id, Number.POSITIVE_INFINITY);
  if (target.type === "group_end") return planChannelMove(room, item.id, target.categoryId, Number.POSITIVE_INFINITY);
  const onto = room.channels.find((c) => c.id === target.id);
  if (!onto) return { ok: false, reason: "unknown" };
  if (isFixedChannel(onto)) return { ok: false, reason: "fixed" };
  return planChannelMove(room, item.id, groupOf(onto), channelGroup(room, groupOf(onto)).findIndex((c) => c.id === onto.id));
}
