// SPDX-License-Identifier: Apache-2.0
import { intlLocale } from "../i18n";

/**
 * The date and time formats of the client. They follow the language chosen in the settings (never the browser's),
 * and their `Intl.DateTimeFormat` is built once per language and style (message rows format on every render).
 * - `date`: the date (15.10.2026 / 10/15/2026), `datetime`: date and time with seconds (the old `toLocaleString()`),
 * - `short` / `medium` / `full`: that date style with the short time, `time`: hours and minutes.
 */
export type DateFormat = "date" | "datetime" | "short" | "medium" | "full" | "time";

const FORMAT_OPTIONS: Record<DateFormat, Intl.DateTimeFormatOptions> = {
  date: { year: "numeric", month: "numeric", day: "numeric" },
  datetime: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" },
  short: { dateStyle: "short", timeStyle: "short" },
  medium: { dateStyle: "medium", timeStyle: "short" },
  full: { dateStyle: "full", timeStyle: "short" },
  time: { hour: "2-digit", minute: "2-digit" },
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(style: DateFormat): Intl.DateTimeFormat {
  const locale = intlLocale();
  const key = `${locale}|${style}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, FORMAT_OPTIONS[style]);
    formatters.set(key, f);
  }
  return f;
}

/** `value` (ISO string, milliseconds or a Date) in one of the client's formats; "" for an invalid date. */
export function formatDate(value: string | number | Date, style: DateFormat): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return formatter(style).format(d);
}

/** A message's time: only the time today, else the date and the time. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = formatter("time").format(d);
  return sameDay ? time : `${formatter("date").format(d)} ${time}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** Stable color derived from a text (for avatars without an image). */
export function hueFor(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Full date and time for the `title` of a `<time>` element (the visible text is often only the time). */
export function formatFullTime(iso: string): string {
  return formatDate(iso, "full");
}

/** `hsl(hue 45% lightness%)` as the 8-bit RGB a browser paints. */
function avatarRgb(hue: number, lightness: number): [number, number, number] {
  const s = 0.45;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

/** Contrast of white text on an 8-bit RGB colour (WCAG relative luminance, as axe computes it). */
export function whiteContrastRgb([r, g, b]: readonly [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
}

/** Below 4.5:1 by a margin: checkers round the ratio to two decimals. */
const AVATAR_MIN_CONTRAST = 4.55;

const avatarColors = new Map<number, string>();

/**
 * Background of a picture-less avatar or room icon: a stable hue from the name, at 40 % lightness, darker for the
 * bright hues (greens, yellows, cyans) so the white initials keep 4.5:1 (WCAG 1.4.3). The colour is given as the exact
 * 8-bit RGB that is checked: an `hsl()` value is rounded by the browser, which can cost a few hundredths of the ratio.
 */
export function avatarBackground(text: string): string {
  const hue = hueFor(text);
  let color = avatarColors.get(hue);
  if (color === undefined) {
    let lightness = 40;
    while (lightness > 20 && whiteContrastRgb(avatarRgb(hue, lightness)) < AVATAR_MIN_CONTRAST) lightness -= 1;
    color = `#${avatarRgb(hue, lightness)
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
    avatarColors.set(hue, color);
  }
  return color;
}
