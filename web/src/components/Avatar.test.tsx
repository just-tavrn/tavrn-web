// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MediaAvatar } from "./Avatar";

const STILL = "https://n.example/api/v1/media/A";
const ANIM = "https://n.example/api/v1/media/A/animated";

function src() {
  return screen.getByTestId("avatar-image").getAttribute("src");
}

describe("MediaAvatar", () => {
  afterEach(() => {
    Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });
  });

  it("shows the still and animates only while a mouse hovers", () => {
    render(<MediaAvatar name="Alice" still={STILL} animated={ANIM} testId="av" />);
    const el = screen.getByTestId("av");
    expect(src()).toBe(STILL);
    expect(el).toHaveAttribute("data-animated", "false");
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    expect(src()).toBe(ANIM);
    expect(el).toHaveAttribute("data-animated", "true");
    fireEvent.pointerLeave(el, { pointerType: "mouse" });
    expect(src()).toBe(STILL);
  });

  it("never animates on touch", () => {
    render(<MediaAvatar name="Alice" still={STILL} animated={ANIM} testId="av" />);
    const el = screen.getByTestId("av");
    const touch = new Event("pointerenter");
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    act(() => {
      el.dispatchEvent(touch);
    });
    expect(src()).toBe(STILL);
  });

  it("animates while the surrounding button has focus and while speaking", () => {
    const { rerender } = render(
      <button type="button" data-testid="host">
        <MediaAvatar name="Alice" still={STILL} animated={ANIM} />
      </button>,
    );
    const host = screen.getByTestId("host");
    act(() => host.focus());
    expect(src()).toBe(ANIM);
    act(() => host.blur());
    expect(src()).toBe(STILL);
    // Hovering the button (not only the image) counts too.
    fireEvent.pointerEnter(host, { pointerType: "mouse" });
    expect(src()).toBe(ANIM);
    fireEvent.pointerLeave(host);
    rerender(
      <button type="button" data-testid="host">
        <MediaAvatar name="Alice" still={STILL} animated={ANIM} speaking />
      </button>,
    );
    expect(src()).toBe(ANIM);
  });

  it("draws the initials as part of the picture, not as text of the control around it (WCAG 2.5.3)", () => {
    render(
      <button type="button" aria-label="Lesbar">
        <MediaAvatar name="Lesbar" testId="av" />
        <span>Lesbar</span>
      </button>,
    );
    expect(screen.getByTestId("avatar-initials")).toHaveAttribute("data-initials", "L");
    expect(screen.getByRole("button", { name: "Lesbar" }).textContent).toBe("Lesbar");
  });

  it("respects reduced motion and falls back to initials", () => {
    Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: () => {}, removeEventListener: () => {} }) });
    const { rerender } = render(<MediaAvatar name="Alice Bob" still={STILL} animated={ANIM} speaking testId="av" />);
    expect(src()).toBe(STILL);
    rerender(<MediaAvatar name="Alice Bob" testId="av" presence="dnd" />);
    expect(within(screen.getByTestId("av")).getByTestId("avatar-initials")).toHaveAttribute("data-initials", "AB");
    expect(screen.getByTestId("presence-dot")).toHaveAttribute("data-status", "dnd");
    // A still without an animated variant never swaps.
    rerender(<MediaAvatar name="Alice" still={STILL} testId="av" />);
    fireEvent.pointerEnter(screen.getByTestId("av"), { pointerType: "mouse" });
    expect(src()).toBe(STILL);
  });
});
