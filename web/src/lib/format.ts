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

/** Contrast of white text on `hsl(hue 45% lightness%)` (WCAG relative luminance). */
function whiteContrast(hue: number, lightness: number): number {
  const s = 0.45;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
  return 1.05 / (lum + 0.05);
}

const avatarLightness = new Map<number, number>();

/**
 * Background of a picture-less avatar or room icon: a stable hue from the name, at 40 % lightness, darker for the
 * bright hues (greens, yellows, cyans) so the white initials keep 4.5:1 (WCAG 1.4.3).
 */
export function avatarBackground(text: string): string {
  const hue = hueFor(text);
  let lightness = avatarLightness.get(hue);
  if (lightness === undefined) {
    lightness = 40;
    while (lightness > 20 && whiteContrast(hue, lightness) < 4.5) lightness -= 1;
    avatarLightness.set(hue, lightness);
  }
  return `hsl(${hue} 45% ${lightness}%)`;
}
