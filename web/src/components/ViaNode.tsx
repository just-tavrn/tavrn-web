// SPDX-License-Identifier: Apache-2.0
import { isNodeDomain } from "@tavrn/sdk";
import { useT } from "../i18n";

/**
 * The node that named an inviter or caller who is not one of its own users (`via` of an invitation or a ring,
 * FEDERATION.md §5.2): that node cannot vouch for the person, so the client shows "via <node>" next to the name and
 * explains it. Null for a missing or malformed value.
 */
export function viaOf(item: unknown): string | null {
  const via = item && typeof item === "object" ? (item as { via?: unknown }).via : undefined;
  if (typeof via !== "string") return null;
  const domain = via.toLowerCase();
  return isNodeDomain(domain) ? domain : null;
}

export function ViaNode({ node }: { node: string }) {
  const t = useT();
  const hint = t("invites.via_hint", { node });
  return (
    <span className="whitespace-nowrap text-warn" title={hint} data-testid="via-node" data-node={node}>
      {t("invites.via", { node })}
      <span className="sr-only">{` (${hint})`}</span>
    </span>
  );
}
