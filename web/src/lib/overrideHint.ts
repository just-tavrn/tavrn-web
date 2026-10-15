// SPDX-License-Identifier: Apache-2.0
/**
 * What the override editors show behind a neutral bit (`inheritedOverrideValue` of the SDK, tavrn-protocol
 * permissions.md "Evaluation"): the input for the editor of a channel's or a category's overrides.
 */
import type { InheritedInput, OverrideInput, RoomDetail } from "@tavrn/sdk";

/** The subject of the edited override: a role, or a member with the ids of their roles (empty until they are loaded). */
export type HintSubject = { type: "role"; id: string } | { type: "member"; id: string; roles: string[] };

type RoomOverride = RoomDetail["overrides"][number];

const toEval = (o: RoomOverride): OverrideInput => ({ subject_type: o.subject_type as "role" | "member", subject_id: o.subject_id, allow: o.allow, deny: o.deny });

/**
 * The roles, in a channel its category's overrides below, and the overrides of the edited layer itself (the channel's
 * or the category's): inside a layer `@everyone` and a member's roles apply before the subject's own override.
 */
export function overrideHintInput(room: RoomDetail, target: { type: "channel" | "category"; id: string }, subject: HintSubject): InheritedInput {
  const everyone = room.roles.find((r) => r.is_everyone);
  const categoryId = target.type === "channel" ? (room.channels.find((c) => c.id === target.id)?.category_id ?? null) : null;
  return {
    everyone_role_id: everyone?.id ?? "",
    everyone_permissions: everyone?.permissions ?? "0",
    roles: room.roles.filter((r) => !r.is_everyone).map((r) => [r.id, r.permissions] as [string, string]),
    subject,
    category_overrides: target.type === "category" ? null : room.overrides.filter((o) => o.target_type === "category" && o.target_id === categoryId).map(toEval),
    layer_overrides: room.overrides.filter((o) => o.target_type === target.type && o.target_id === target.id).map(toEval),
  };
}
