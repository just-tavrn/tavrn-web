// SPDX-License-Identifier: Apache-2.0
/**
 * Who may upload which file types (tavrn-protocol permissions.md "Upload categories"; the node's
 * `uploads::effective`), for the editors of roles and overrides: the effective categories of a subject and what a
 * neutral category in an override inherits. The node decides; this only explains its decision in the settings.
 */
import { UPLOAD_CATEGORIES, type UploadCategoryName } from "@tavrn/sdk";

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

/**
 * What a neutral category keeps in an override of the subject: the roles and, in the channel editor, the category's
 * overrides (`source` is `category` when one of them that applies to the subject allows or denies it).
 */
export function inheritedUpload(s: UploadSubject, categoryOverrides: readonly UploadOverrideInput[] | null, category: string): { allowed: boolean; source: "role" | "category" } {
  const layers = categoryOverrides ? [categoryOverrides] : [];
  const applies = (o: UploadOverrideInput) => (o.subject_type === "role" ? o.subject_id === s.everyoneId || s.roles.some((r) => r.id === o.subject_id) : o.subject_id === s.memberId);
  const touched = !s.privileged && (categoryOverrides ?? []).some((o) => applies(o) && [...(o.upload_allow ?? []), ...(o.upload_deny ?? [])].includes(category));
  return { allowed: effectiveUploads(s, layers).includes(category as UploadCategoryName), source: touched ? "category" : "role" };
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
