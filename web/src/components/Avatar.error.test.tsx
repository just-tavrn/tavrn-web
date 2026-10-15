// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MediaAvatar } from "./Avatar";
import { hueFor } from "../lib/format";

describe("MediaAvatar: failed images", () => {
  it("falls back to the still when the animated variant fails", () => {
    render(<MediaAvatar name="Alice" still="https://n.test/still.webp" animated="https://n.test/anim.webp" testId="av" />);
    const host = screen.getByTestId("av");
    fireEvent.pointerEnter(host, { pointerType: "mouse" });
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/anim.webp");
    fireEvent.error(screen.getByTestId("avatar-image"));
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/still.webp");
    fireEvent.pointerLeave(host);
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/still.webp");
  });

  it("shows a new image after an earlier one failed", () => {
    const { rerender } = render(<MediaAvatar name="Alice" still="https://n.test/old.webp" />);
    fireEvent.error(screen.getByTestId("avatar-image"));
    expect(screen.queryByTestId("avatar-image")).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
    rerender(<MediaAvatar name="Alice" still="https://n.test/new.webp" />);
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/new.webp");
  });
});

describe("MediaAvatar: initials and the still image", () => {
  /** Contrast of white on a computed `rgb(r, g, b)` background (as axe reads it). */
  function whiteOn(rgb: string): number {
    const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map((x) => Number(x) / 255) as [number, number, number];
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
  }

  it("draws the initials in white on a background of at least 4.5:1 for any name", () => {
    // One name per hue (the background depends on the hue of the name only).
    const byHue = new Map<number, string>();
    for (let i = 0; byHue.size < 360 && i < 20000; i++) {
      const name = `Room ${i}`;
      if (!byHue.has(hueFor(name))) byHue.set(hueFor(name), name);
    }
    expect(byHue.size).toBe(360);
    const { container, rerender } = render(<MediaAvatar name="x" shape="squircle" testId="room-icon" />);
    for (const name of byHue.values()) {
      rerender(<MediaAvatar name={name} shape="squircle" testId="room-icon" />);
      const initials = container.querySelector<HTMLElement>('[data-testid="room-icon"] > span')!;
      expect(initials.className).toContain("text-white");
      const bg = initials.style.backgroundColor;
      expect(bg).toMatch(/^rgb\(/);
      expect(Math.round(whiteOn(bg) * 100) / 100).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("shows the still image when there is one, without animation", () => {
    render(<MediaAvatar name="Raum" still="https://n.test/still.webp" shape="squircle" testId="room-icon" />);
    const icon = screen.getByTestId("room-icon");
    expect(icon).toHaveAttribute("data-has-animation", "false");
    expect(screen.getByTestId("avatar-image")).toHaveAttribute("src", "https://n.test/still.webp");
  });
});
