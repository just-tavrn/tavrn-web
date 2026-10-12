// SPDX-License-Identifier: Apache-2.0
/**
 * Forwarding reports to the reported user's home node (protocol MODERATION.md §1.6, capability `reports.v2`): which
 * reports node admins may forward, and where to.
 */
import type { ModerationReport } from "@tavrn/sdk";

/** The home node of an address (`user@domain`), or null. */
export function homeNodeOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1 ? address.slice(at + 1).toLowerCase() : null;
}

/**
 * The node a report can be forwarded to by the admins of `ownDomain`: reports by users (not automod entries, not
 * reports other nodes forwarded) about a user of another node that were not forwarded yet. Null otherwise.
 */
export function forwardTarget(report: Pick<ModerationReport, "source" | "kind" | "target_address" | "forwarded">, ownDomain: string): string | null {
  if (report.source !== "user" || (report.kind !== "message" && report.kind !== "user") || report.forwarded) return null;
  const home = homeNodeOf(report.target_address);
  return home && home !== ownDomain.toLowerCase() ? home : null;
}
