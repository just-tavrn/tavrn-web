// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { avatarBackground, hueFor } from "./format";

/** Contrast of white on an `hsl(h s% l%)` string, computed independently (via the browser-free formula). */
function contrastOfWhite(hsl: string): number {
  const [h, s, l] = hsl.match(/[\d.]+/g)!.map(Number) as [number, number, number];
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const lin = (v: number) => (v + m <= 0.03928 ? (v + m) / 12.92 : ((v + m + 0.055) / 1.055) ** 2.4);
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
}

describe("avatarBackground", () => {
  it("keeps white initials at 4.5:1 for every hue and the usual 40 % where that suffices", () => {
    const names = Array.from({ length: 2000 }, (_, i) => `name-${i}`);
    const hues = new Set(names.map(hueFor));
    expect(hues.size).toBeGreaterThan(300);
    for (const name of names) expect(contrastOfWhite(avatarBackground(name))).toBeGreaterThanOrEqual(4.5);
    // A blue keeps the old look.
    const blue = names.find((n) => hueFor(n) === 220)!;
    expect(avatarBackground(blue)).toBe("hsl(220 45% 40%)");
  });
});
