// SPDX-License-Identifier: Apache-2.0
/**
 * Who may upload which file types (tavrn-protocol permissions.md "Upload categories"; the node's
 * `uploads::effective`), for the editors of roles and overrides: the effective categories of a subject and what a
 * neutral category in an override inherits. The node decides; this only explains its decision in the settings.
 */
import { UPLOAD_CATEGORIES, type InheritedSource, type UploadCategoryName } from "@tavrn/sdk";

/** An override's upload masks as the room detail carries them. */
export interface UploadOverrideInput {
  subject_type: string;
  subject_id: string;
  upload_allow?: readonly string[] | null;
  upload_deny?: readonly string[] | null;
}

/** The subject the editor looks at: its roles (without `@everyone`), or a member with theirs. */
export interface UploadSubject {
  everyoneId: string;
  /** `@everyone`'s categories (null/absent: every category, the node's default). */
  everyone: readonly string[] | null | undefined;
  roles: { id: string; position: number; categories: readonly string[] | null | undefined }[];
  memberId?: string;
  /** Owner, node admin or `administrator`: every category. */
  privileged?: boolean;
}

export type UploadOverrideState = "allow" | "neutral" | "deny";

const inOrder = (set: Set<string>): UploadCategoryName[] => UPLOAD_CATEGORIES.filter((c) => set.has(c));

function roleBase(s: UploadSubject): Set<string> {
  if (s.privileged) return new Set(UPLOAD_CATEGORIES);
  // The highest role with a value wins (equal positions: the smaller id, like the node), else `@everyone`.
  const decided = s.roles
    .filter((r) => r.categories != null)
    .sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return new Set(decided?.categories ?? s.everyone ?? UPLOAD_CATEGORIES);
}

function apply(cats: Set<string>, allow: readonly string[] | null | undefined, deny: readonly string[] | null | undefined) {
  for (const c of deny ?? []) cats.delete(c);
  for (const c of allow ?? []) cats.add(c);
}

function applyLayer(cats: Set<string>, s: UploadSubject, overrides: readonly UploadOverrideInput[]) {
  const everyone = overrides.find((o) => o.subject_type === "role" && o.subject_id === s.everyoneId);
  if (everyone) apply(cats, everyone.upload_allow, everyone.upload_deny);
  const allow: string[] = [];
  const deny: string[] = [];
  for (const o of overrides) {
    if (o.subject_type === "role" && s.roles.some((r) => r.id === o.subject_id)) {
      allow.push(...(o.upload_allow ?? []));
      deny.push(...(o.upload_deny ?? []));
    }
  }
  apply(cats, allow, deny);
  const member = s.memberId ? overrides.find((o) => o.subject_type === "member" && o.subject_id === s.memberId) : undefined;
  if (member) apply(cats, member.upload_allow, member.upload_deny);
}

/** The categories the subject may upload with the override layers (the category's, then the channel's). */
export function effectiveUploads(s: UploadSubject, layers: readonly (readonly UploadOverrideInput[])[]): UploadCategoryName[] {
  const cats = roleBase(s);
  if (!s.privileged) for (const layer of layers) applyLayer(cats, s, layer);
  return inOrder(cats);
}

/** The edited layer of an override editor: its overrides and the subject whose override is being edited. */
export interface EditedUploadLayer {
  overrides: readonly UploadOverrideInput[];
  subject: { type: string; id: string };
}

/**
 * What a neutral category keeps in an override of the subject: the roles, in the channel editor the category's
 * overrides, then inside the edited layer the `@everyone` override and the overrides of a member's roles (never the
 * subject's own). `source` names the last of these that allows or denies the category, as `inheritedOverrideValue`
 * of the SDK does for permission bits.
 */
export function inheritedUpload(s: UploadSubject, categoryOverrides: readonly UploadOverrideInput[] | null, category: string, edited?: EditedUploadLayer): { allowed: boolean; source: InheritedSource } {
  const below = categoryOverrides ?? [];
  const layer = (edited?.overrides ?? []).filter((o) => o.subject_type === "role" && !(o.subject_type === edited?.subject.type && o.subject_id === edited.subject.id));
  const touches = (o: UploadOverrideInput) => [...(o.upload_allow ?? []), ...(o.upload_deny ?? [])].includes(category);
  const applies = (o: UploadOverrideInput) => (o.subject_type === "role" ? o.subject_id === s.everyoneId || s.roles.some((r) => r.id === o.subject_id) : o.subject_id === s.memberId);
  let source: InheritedSource = "role";
  if (!s.privileged) {
    if (below.some((o) => applies(o) && touches(o))) source = "category";
    if (layer.some((o) => o.subject_id === s.everyoneId && touches(o))) source = "everyone";
    if (layer.some((o) => o.subject_id !== s.everyoneId && s.roles.some((r) => r.id === o.subject_id) && touches(o))) source = "roles";
  }
  const layers = categoryOverrides ? [categoryOverrides, layer] : [layer];
  return { allowed: effectiveUploads(s, layers).includes(category as UploadCategoryName), source };
}

export function overrideUploadState(o: Pick<UploadOverrideInput, "upload_allow" | "upload_deny">, category: string): UploadOverrideState {
  if (o.upload_allow?.includes(category)) return "allow";
  if (o.upload_deny?.includes(category)) return "deny";
  return "neutral";
}

/** The masks with one category set to allow, neutral or deny (in API order). */
export function setOverrideUpload(o: Pick<UploadOverrideInput, "upload_allow" | "upload_deny">, category: string, state: UploadOverrideState): { upload_allow: string[]; upload_deny: string[] } {
  const allow = (o.upload_allow ?? []).filter((c) => c !== category);
  const deny = (o.upload_deny ?? []).filter((c) => c !== category);
  if (state === "allow") allow.push(category);
  if (state === "deny") deny.push(category);
  return { upload_allow: inOrder(new Set(allow)), upload_deny: inOrder(new Set(deny)) };
}
