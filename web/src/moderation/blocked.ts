// SPDX-License-Identifier: Apache-2.0
/** The composer's message for a send refused by auto-moderation (`403 automod.blocked`, MODERATION.md §2.2). */
import { TavrnApiError } from "@tavrn/sdk";

export function isAutomodBlock(e: unknown): e is TavrnApiError {
  return e instanceof TavrnApiError && e.code === "automod.blocked";
}

/** The rule's name and whether it is the node's own list, from the problem's `meta`. */
export function blockedRule(e: TavrnApiError): { rule: string; node: boolean } {
  const meta = (e.problem as { meta?: { rule?: unknown; scope?: unknown } }).meta ?? {};
  return { rule: typeof meta.rule === "string" ? meta.rule : "", node: meta.scope === "node" };
}

/** The text the composer shows (translated by the caller's `t`). */
export function blockedText(e: TavrnApiError, t: (key: string, params?: Record<string, string | number>) => string): string {
  const { rule, node } = blockedRule(e);
  return node || !rule ? t("automod.blocked_node") : t("automod.blocked_rule", { rule });
}
