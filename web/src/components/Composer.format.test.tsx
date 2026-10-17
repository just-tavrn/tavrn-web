// SPDX-License-Identifier: Apache-2.0
// The composer's formatting bar and shortcuts (docs/CLIENT.md "The composer"): the toggle and its stored preference,
// wrapping and unwrapping the selection, inserting markers, focus and undo, the toolbar's keyboard pattern.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { COMPOSER_PREFS_KEY, useComposerPrefs } from "../stores/composerPrefs";

afterEach(() => {
  act(() => useComposerPrefs.getState().set({ formatBar: false, styledInput: false }));
  localStorage.clear();
});

function setup() {
  render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
  return { box: screen.getByLabelText("Nachricht") as HTMLTextAreaElement, u: userEvent.setup() };
}
const bar = () => screen.queryByRole("toolbar", { name: "Formatierung" });
const barButton = (name: RegExp) => within(bar()!).getByRole("button", { name });

describe("Composer: formatting bar", () => {
  it("the Formatting toggle shows and hides the bar and remembers it on this device", async () => {
    const { u } = setup();
    const toggle = screen.getByRole("button", { name: "Formatierung" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(bar()).toBeNull();
    await u.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-controls", bar()!.id);
    expect(JSON.parse(localStorage.getItem(COMPOSER_PREFS_KEY)!)).toMatchObject({ formatBar: true });
    // One button per supported format, with the shortcut in the tooltip.
    expect(within(bar()!).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Fett",
      "Kursiv",
      "Durchgestrichen",
      "Spoiler",
      "Code im Text",
      "Codeblock",
      "Link",
      "Zitat",
      "Aufzählung",
      "Nummerierte Liste",
    ]);
    expect(barButton(/^Fett/)).toHaveAttribute("title", "Fett (Strg+B)");
    expect(barButton(/^Durchgestrichen/)).toHaveAttribute("title", "Durchgestrichen (Strg+Umschalt+X)");
    expect(barButton(/^Fett/)).toHaveAttribute("aria-keyshortcuts", "Control+B");
    await u.click(toggle);
    expect(bar()).toBeNull();
  });

  it("wraps the selection, keeps the focus in the text box and toggles off again", async () => {
    act(() => useComposerPrefs.getState().set({ formatBar: true }));
    const { box, u } = setup();
    await u.type(box, "ein wort hier");
    box.setSelectionRange(4, 8);
    await u.click(barButton(/^Fett/));
    expect(box.value).toBe("ein **wort** hier");
    expect(box).toHaveFocus();
    expect([box.selectionStart, box.selectionEnd]).toEqual([6, 10]);
    await u.click(barButton(/^Fett/));
    expect(box.value).toBe("ein wort hier");
    await u.click(barButton(/^Zitat/));
    expect(box.value).toBe("> ein wort hier");
  });

  it("inserts empty markers with the caret between them", async () => {
    act(() => useComposerPrefs.getState().set({ formatBar: true }));
    const { box, u } = setup();
    await u.click(barButton(/^Code im Text/));
    expect(box.value).toBe("``");
    expect(box.selectionStart).toBe(1);
    await u.keyboard("x()");
    expect(box.value).toBe("`x()`");
  });

  it("Ctrl/Cmd shortcuts: B, I, Shift+X, E and Shift+S", async () => {
    const { box, u } = setup();
    await u.type(box, "abc");
    box.setSelectionRange(0, 3);
    await u.keyboard("{Control>}b{/Control}");
    expect(box.value).toBe("**abc**");
    await u.keyboard("{Control>}i{/Control}");
    expect(box.value).toBe("***abc***");
    await u.keyboard("{Meta>}i{/Meta}{Control>}b{/Control}");
    expect(box.value).toBe("abc");
    await u.keyboard("{Control>}{Shift>}X{/Shift}{/Control}");
    expect(box.value).toBe("~~abc~~");
    await u.keyboard("{Control>}{Shift>}X{/Shift}{/Control}{Control>}e{/Control}");
    expect(box.value).toBe("`abc`");
    await u.keyboard("{Control>}e{/Control}{Control>}{Shift>}S{/Shift}{/Control}");
    expect(box.value).toBe("||abc||");
  });

  it("Ctrl+Z undoes a formatting step (and Ctrl+Shift+Z redoes it); typed text goes back to the browser's undo", async () => {
    const { box, u } = setup();
    await u.type(box, "abc");
    box.setSelectionRange(0, 3);
    await u.keyboard("{Control>}b{/Control}{Control>}i{/Control}");
    expect(box.value).toBe("***abc***");
    await u.keyboard("{Control>}z{/Control}");
    expect(box.value).toBe("**abc**");
    expect([box.selectionStart, box.selectionEnd]).toEqual([2, 5]);
    await u.keyboard("{Control>}z{/Control}");
    expect(box.value).toBe("abc");
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 3]);
    await u.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(box.value).toBe("**abc**");
    // Typed since the last step: the composer leaves Ctrl+Z to the browser (jsdom has no native undo).
    box.setSelectionRange(7, 7);
    await u.keyboard("!");
    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(box.value).toBe("**abc**!");
  });

  it("the toolbar has one tab stop and moves with the arrow keys", async () => {
    act(() => useComposerPrefs.getState().set({ formatBar: true }));
    const { u } = setup();
    const buttons = within(bar()!).getAllByRole("button");
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0]!.focus();
    await u.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
    await u.keyboard("{End}");
    expect(buttons.at(-1)).toHaveFocus();
    await u.keyboard("{ArrowRight}");
    expect(buttons[0]).toHaveFocus();
    await u.keyboard("{ArrowLeft}");
    expect(buttons.at(-1)).toHaveFocus();
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons.at(-1)]);
  });

  it("the per-file spoiler toggles of uploads stay", async () => {
    const onUpload = vi.fn(async (file: File) => ({ id: "01J00000000000000000000000", name: file.name, mime: file.type, size: file.size, sha256: "x" }));
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} />);
    const u = userEvent.setup();
    await u.upload(screen.getByLabelText("Datei auswählen") as HTMLInputElement, new File(["abc"], "b.png", { type: "image/png" }));
    expect(await screen.findByRole("button", { name: "b.png als Spoiler markieren" })).toBeInTheDocument();
  });

  it("is hidden while the composer is disabled", () => {
    act(() => useComposerPrefs.getState().set({ formatBar: true }));
    render(<Composer placeholder="Nachricht" disabled onSend={vi.fn()} />);
    expect(bar()).toBeNull();
    expect(screen.queryByRole("button", { name: "Formatierung" })).toBeNull();
  });
});
