// SPDX-License-Identifier: Apache-2.0
/**
 * Showing rich activities (APPLICATIONS.md §7.2): "via <application name>" and, when the client already
 * knows the bot user of the application, its avatar. No other images, buttons or party joins.
 */
import type { Activity, User } from "@tavrn/sdk";

/**
 * The bot user of the application `ref` (`<domain>/<id>`) among `users`: a remote bot carries the full
 * reference in `application_id`, a local bot only the id (its `domain` completes it). Users of kind
 * `user` never match.
 */
export function botOfApplication<U extends Pick<User, "kind" | "domain" | "application_id">>(ref: string | null | undefined, users: Iterable<U>): U | null {
  if (!ref) return null;
  const want = normalizeRef(ref);
  for (const u of users) {
    if (!u || u.kind === "user" || !u.application_id) continue;
    const id = u.application_id;
    const full = id.includes("/") ? id : `${u.domain}/${id}`;
    if (normalizeRef(full) === want) return u;
  }
  return null;
}

/** Domains compare case-insensitively, ULIDs too (Crockford base32). */
function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

/** `ends_at` if it lies in the future (else null: nothing to show). */
export function activityEnd(a: Pick<Activity, "ends_at"> | null | undefined, now = Date.now()): Date | null {
  if (!a?.ends_at) return null;
  const t = Date.parse(a.ends_at);
  return Number.isFinite(t) && t > now ? new Date(t) : null;
}

/** "22:15" today, else a short date and time, in the given locale. */
export function formatEnd(end: Date, locale: string, now = new Date()): string {
  const sameDay = end.toDateString() === now.toDateString();
  return sameDay
    ? end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : end.toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
