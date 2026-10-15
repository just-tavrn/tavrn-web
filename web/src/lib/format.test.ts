// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { avatarBackground, hueFor } from "./format";

/** Contrast of white on a `#rrggbb` colour, computed independently as axe does (8-bit channels, WCAG luminance). */
function contrastOfWhite(hex: string): number {
  const [r, g, b] = (hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/) ?? []).slice(1).map((x) => parseInt(x, 16) / 255) as [number, number, number];
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
}

describe("avatarBackground", () => {
  it("keeps white initials at 4.5:1 for every hue and the usual 40 % where that suffices", () => {
    const names = Array.from({ length: 2000 }, (_, i) => `name-${i}`);
    const hues = new Set(names.map(hueFor));
    expect(hues.size).toBeGreaterThan(300);
    // Rounded to two decimals as the checkers report it: never below 4.5 (a hue of 37 at 40 % gave 4.48).
    for (const name of names) expect(Math.round(contrastOfWhite(avatarBackground(name)) * 100) / 100).toBeGreaterThanOrEqual(4.5);
    // A blue keeps the old look (hsl(220 45% 40%)).
    const blue = names.find((n) => hueFor(n) === 220)!;
    expect(avatarBackground(blue)).toBe("#385794");
    // The colour axe measured at 4.48 is not produced any more.
    const gold = names.find((n) => hueFor(n) === 37)!;
    expect(avatarBackground(gold)).not.toBe("#947138");
  });
});

describe("formatDate", () => {
  it("follows the language of the settings, not the browser's", async () => {
    const { formatDate, formatTime, formatFullTime } = await import("./format");
    const { useLocale } = await import("../i18n");
    const iso = "2026-03-04T05:06:07Z";
    const before = useLocale.getState().locale;
    try {
      useLocale.setState({ locale: "de" });
      expect(formatDate(iso, "date")).toBe(new Intl.DateTimeFormat("de-DE").format(new Date(iso)));
      expect(formatDate(iso, "short")).toBe(new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }));
      expect(formatDate(iso, "datetime")).toBe(new Date(iso).toLocaleString("de-DE"));
      expect(formatFullTime(iso)).toBe(new Date(iso).toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" }));
      expect(formatTime(iso)).toBe(`${new Date(iso).toLocaleDateString("de-DE")} ${new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`);
      useLocale.setState({ locale: "en" });
      expect(formatDate(iso, "date")).toBe(new Intl.DateTimeFormat("en-US").format(new Date(iso)));
      expect(formatDate("not a date", "medium")).toBe("");
    } finally {
      useLocale.setState({ locale: before });
    }
  });
});
