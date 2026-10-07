// SPDX-License-Identifier: Apache-2.0
/** Relative times for thread indicators and post cards ("5 minutes ago"), localized through `Intl`. */

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** `iso` relative to `now` in `locale` ("now" below a minute). */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const then = Date.parse(iso);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (!Number.isFinite(then)) return "";
  const secs = Math.round((then - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(secs) >= size) return fmt.format(Math.trunc(secs / size), unit);
  }
  return fmt.format(0, "second");
}
