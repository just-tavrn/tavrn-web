// SPDX-License-Identifier: Apache-2.0
/**
 * Address first in the desktop app (docs/DESKTOP.md "Signing in"): `alice@home.example` names the account and its
 * node. The shell resolves the identity domain as FEDERATION.md §1.4 says (well-known, SRV, direct) and the app then
 * talks to the node found there (the endpoints may live on another host: delegation).
 */
import { isNodeDomain } from "@tavrn/sdk";
import { platform } from "../platform";
import type { ResolveFailure, ResolvedNode } from "../platform";
import { t } from "../i18n";

const USERNAME = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
/** A development node on this computer (the shell reaches it over plain http). */
const DEV_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** A node domain, or a development node on this computer (`localhost:8080`). */
export function isAppNodeDomain(domain: string): boolean {
  return isNodeDomain(domain) || DEV_HOST.test(domain);
}

/** `alice@home.example` (also `alice@localhost:8080` for development nodes) → username and domain; null otherwise. */
export function parseAppAddress(input: string): { username: string; domain: string } | null {
  const s = input.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return null;
  const username = s.slice(0, at);
  const domain = s.slice(at + 1);
  return USERNAME.test(username) && isAppNodeDomain(domain) ? { username, domain } : null;
}

/** What the user typed into the node picker: an address or just the identity domain. */
export function parseAppAccountInput(input: string): { username: string | null; domain: string } | null {
  const address = parseAppAddress(input);
  if (address) return address;
  const domain = input.trim().toLowerCase().replace(/^@/, "");
  return domain && isAppNodeDomain(domain) ? { username: null, domain } : null;
}

/** The node's base URL for the API client: `api` without `/api/v1`. */
export function baseOf(found: ResolvedNode): string {
  return found.api.replace(/\/api\/v1\/?$/, "");
}

/** Resolves `domain` in the shell and makes the node found there the app's node (no reload). */
export async function switchToNodeOf(domain: string): Promise<ResolvedNode> {
  const choice = platform().node;
  if (!choice?.resolve) throw new Error(t("resolve.error.unavailable"));
  const found = await choice.resolve(domain);
  await choice.set(baseOf(found), { domain: found.domain, web: found.web });
  return found;
}

function isResolveFailure(e: unknown): e is ResolveFailure {
  const f = e as Partial<ResolveFailure> | null;
  return !!f && typeof f.code === "string" && f.code.startsWith("resolve.") && typeof f.step === "string";
}

/** The message for a failed resolution: what went wrong and which step failed. */
export function resolveErrorMessage(e: unknown, domain: string): string | null {
  if (!isResolveFailure(e)) return null;
  const what = t(`resolve.error.${e.code.slice("resolve.".length)}`, { domain: e.domain || domain });
  const step = t(`resolve.step.${e.step}`, { domain: e.domain || domain });
  return `${what} ${t("resolve.failed_step", { step })}`;
}
