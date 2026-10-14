// SPDX-License-Identifier: Apache-2.0
/**
 * Time zones of date polls (PROTOCOL.md §7g): slots carry RFC 3339 times with the creator's offset; they are shown in
 * the viewer's zone, with the creator's wall time as a hint when the offsets differ. Every helper takes an optional
 * IANA `timeZone` (tests use fake zones); without it the device's zone applies.
 */

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** The parts of an RFC 3339 time as written (the creator's wall time and offset). */
export interface WallTime {
  date: string;
  hour: number;
  minute: number;
  /** Minutes east of UTC. */
  offset: number;
}

export function parseRfc3339(s: string): WallTime | null {
  const m = RFC3339.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  const hour = Number(h);
  const minute = Number(mi);
  if (hour > 23 || minute > 59 || Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  let offset = 0;
  if (z!.toUpperCase() !== "Z") {
    const sign = z![0] === "-" ? -1 : 1;
    offset = sign * (Number(z!.slice(1, 3)) * 60 + Number(z!.slice(4, 6)));
  }
  return { date: `${y}-${mo}-${d}`, hour, minute, offset };
}

/** Is `s` an RFC 3339 time with an offset (or `Z`) that names a real instant? */
export function isRfc3339(s: unknown): s is string {
  return typeof s === "string" && parseRfc3339(s) !== null && Number.isFinite(Date.parse(s));
}

/** Minutes east of UTC of `timeZone` (or the device's zone) at the instant `ms`. */
export function offsetMinutes(ms: number, timeZone?: string): number {
  if (!timeZone) return -new Date(ms).getTimezoneOffset();
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant of a wall time (`YYYY-MM-DD`, `HH:MM`) in `timeZone` (or the device's zone). */
export function zonedInstant(date: string, time: string, timeZone?: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  if (!timeZone) return new Date(y, mo - 1, d, h, mi).getTime();
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two rounds settle the offset around daylight saving changes.
  let guess = wall - offsetMinutes(wall, timeZone) * 60_000;
  guess = wall - offsetMinutes(guess, timeZone) * 60_000;
  return guess;
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");

/** `+02:00` / `-04:00` / `+00:00`. */
export function offsetText(minutes: number): string {
  return `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The instant `ms` as RFC 3339 in the wall time of `timeZone` (or the device's zone), with its offset. */
export function toRfc3339(ms: number, timeZone?: string): string {
  const offset = offsetMinutes(ms, timeZone);
  const wall = new Date(ms + offset * 60_000);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:00${offsetText(offset)}`;
}

/** `YYYY-MM-DD` of the instant `ms` in `timeZone` (or the device's zone). */
export function dayOf(ms: number, timeZone?: string): string {
  const wall = new Date(ms + offsetMinutes(ms, timeZone) * 60_000);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
}

/** Calendar arithmetic on `YYYY-MM-DD` (no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Same day of the month `n` months later (clamped to the month's last day). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}

/** Day of the week, 1 = Monday … 7 = Sunday. */
export function weekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** The first day of the week of a locale (1 = Monday, 7 = Sunday). */
export function firstDayOfWeek(locale: string): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay ?? 1;
  } catch {
    return 1;
  }
}

/** The short name of the viewer's zone (`MESZ`, `EDT`, `GMT+2`) at `ms`, for "times in your zone". */
export function zoneName(ms: number, locale: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
