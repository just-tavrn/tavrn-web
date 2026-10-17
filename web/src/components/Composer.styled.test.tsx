// SPDX-License-Identifier: Apache-2.0
// The composer's styled input (docs/CLIENT.md "The composer"): an opt-in highlight layer behind the textarea, with the
// same characters (so the caret aligns), toggled in the formatting bar and remembered on this device.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { COMPOSER_PREFS_KEY, useComposerPrefs } from "../stores/composerPrefs";
import { STYLED_MAX } from "../composer/highlight";

afterEach(() => {
  act(() => useComposerPrefs.getState().set({ formatBar: false, styledInput: false }));
  localStorage.clear();
});

const box = () => screen.getByLabelText("Nachricht") as HTMLTextAreaElement;
const layer = () => screen.queryByTestId("styled-layer");

describe("Composer: styled input", () => {
  it("is off by default; the toggle in the formatting bar turns it on and the choice is remembered", async () => {
    act(() => useComposerPrefs.getState().set({ formatBar: true }));
    const u = userEvent.setup();
    const view = render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    expect(layer()).toBeNull();
    const toggle = within(screen.getByRole("toolbar", { name: "Formatierung" })).getByRole("button", { name: "Formatierung beim Schreiben zeigen" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await u.click(box());
    await u.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(layer()).not.toBeNull();
    expect(box()).toHaveFocus();
    expect(JSON.parse(localStorage.getItem(COMPOSER_PREFS_KEY)!)).toMatchObject({ styledInput: true });
    // Another composer (another conversation, a reload) starts with it on.
    view.unmount();
    useComposerPrefs.getState().reload();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    expect(layer()).not.toBeNull();
  });

  it("the layer holds exactly the textarea's characters, formatted, hidden from screen readers", async () => {
    act(() => useComposerPrefs.getState().set({ styledInput: true }));
    const u = userEvent.setup();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    const text = "**fett** und _kursiv_{Shift>}{Enter}{/Shift}> zitat `code` ||weg||{Shift>}{Enter}{/Shift}";
    await u.type(box(), text);
    expect(box().value).toBe("**fett** und _kursiv_\n> zitat `code` ||weg||\n");
    // Same characters, the final line break included (the caret aligns on every line).
    expect(layer()!.textContent).toBe(box().value);
    expect(layer()).toHaveAttribute("aria-hidden", "true");
    expect(layer()!.querySelector(".cs-bold")).toHaveTextContent("fett");
    expect(layer()!.querySelector(".cs-code:not(.cs-mark)")).toHaveTextContent("code");
    expect(layer()!.querySelector(".cs-spoiler")).toHaveTextContent("weg");
    expect(box().className).toContain("composer-styled");
    // Typing on keeps them equal (the layer follows every input).
    await u.type(box(), "@niemand ~~x~~");
    expect(layer()!.textContent).toBe(box().value);
  });

  it("marks the conversation's mentions and follows the textarea's scrolling", async () => {
    act(() => useComposerPrefs.getState().set({ styledInput: true }));
    const u = userEvent.setup();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} mentions={[{ kind: "user", key: "bob@a", insert: "@bob", name: "Bob", username: "bob" }]} />);
    await u.type(box(), "hi @bob ");
    expect(layer()!.querySelector(".cs-mention")).toHaveTextContent("@bob");
    box().scrollTop = 40;
    fireEvent.scroll(box());
    expect(layer()!.scrollTop).toBe(box().scrollTop);
  });

  it("falls back to the plain input for very long texts and while the composer is disabled", async () => {
    act(() => useComposerPrefs.getState().set({ styledInput: true }));
    const view = render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    fireEvent.change(box(), { target: { value: "x".repeat(STYLED_MAX + 1) } });
    expect(layer()).toBeNull();
    expect(box().className).not.toContain("composer-styled");
    fireEvent.change(box(), { target: { value: "kurz" } });
    expect(layer()).not.toBeNull();
    view.rerender(<Composer placeholder="Nachricht" disabled onSend={vi.fn()} />);
    expect(layer()).toBeNull();
  });
});
