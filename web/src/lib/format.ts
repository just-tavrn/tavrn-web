// SPDX-License-Identifier: Apache-2.0
import { intlLocale } from "../i18n";

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(intlLocale())} ${time}`;
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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(intlLocale(), { dateStyle: "full", timeStyle: "short" });
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
