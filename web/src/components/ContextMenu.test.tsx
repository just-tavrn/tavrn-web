// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, LONG_PRESS_MS, MenuButton, findEntry, menuItem, normalizeMenu, separator, submenu, useContextMenu, type MenuEntry } from "./ContextMenu";

function Harness({ entries }: { entries: MenuEntry[] }) {
  const menu = useContextMenu();
  return (
    <div>
      <div data-testid="target" {...menu.triggerProps}>
        target
      </div>
      <MenuButton menu={menu} label="More" />
      <button type="button">outside</button>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label="Menu" />}
    </div>
  );
}

describe("normalizeMenu", () => {
  it("drops falsy entries, empty submenus and stray separators", () => {
    const entries = normalizeMenu([separator("a"), menuItem("x", "X", undefined), false, separator("b"), separator("c"), submenu("empty", "E", []), null, menuItem("y", "Y", undefined), separator("d")]);
    expect(entries.map((e) => e.id)).toEqual(["x", "b", "y"]);
    expect(findEntry([submenu("s", "S", [menuItem("deep", "Deep", undefined)])], "deep")?.label).toBe("Deep");
  });
});

describe("ContextMenu", () => {
  it("opens on right-click at the pointer, suppresses the browser menu and runs the chosen item", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness entries={[menuItem("a", "Alpha", onSelect)]} />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    act(() => {
      screen.getByTestId("target").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const menu = screen.getByRole("menu", { name: "Menu" });
    // Portaled into the body, never inside the target.
    expect(menu.closest("[data-context-menu-layer]")?.parentElement).toBe(document.body);
    await user.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is keyboard navigable: arrows skip separators, Enter chooses, Escape closes", async () => {
    const user = userEvent.setup();
    const b = vi.fn();
    render(<Harness entries={normalizeMenu([menuItem("a", "Alpha", vi.fn()), separator("s"), menuItem("b", "Beta", b), menuItem("c", "Gamma", vi.fn())])} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Beta" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(b).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens submenus with the arrow keys and closes them with ArrowLeft", async () => {
    const user = userEvent.setup();
    const pick = vi.fn();
    render(<Harness entries={[submenu("sub", "Timeout", [menuItem("t1", "1 minute", pick)])]} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Timeout" })).toHaveAttribute("aria-haspopup", "menu");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "1 minute" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("menuitem", { name: "1 minute" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Timeout" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(pick).toHaveBeenCalled();
  });

  it("keeps disabled items focusable with their reason but does not run them; checkbox items stay open", async () => {
    const user = userEvent.setup();
    const blocked = vi.fn();
    const toggle = vi.fn();
    render(<Harness entries={[menuItem("x", "Kick", blocked, { disabled: true, reason: "Higher role" }), menuItem("r", "Mod", toggle, { checked: false, keepOpen: true })]} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    const kick = screen.getByRole("menuitem", { name: "Kick" });
    expect(kick).toHaveAttribute("aria-disabled", "true");
    expect(kick).toHaveAttribute("title", "Higher role");
    await user.click(kick);
    expect(blocked).not.toHaveBeenCalled();
    const role = screen.getByRole("menuitemcheckbox", { name: "Mod" });
    expect(role).toHaveAttribute("aria-checked", "false");
    await user.click(role);
    expect(toggle).toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    render(<Harness entries={[menuItem("a", "Alpha", vi.fn())]} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await act(() => new Promise((r) => setTimeout(r, 5)));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on a long press on touch devices and swallows the following click", () => {
    vi.useFakeTimers();
    try {
      const onClick = vi.fn();
      function Touch() {
        const menu = useContextMenu();
        return (
          <>
            <button type="button" data-testid="t" onClick={onClick} {...menu.triggerProps}>
              t
            </button>
            {menu.open && menu.anchor && <ContextMenu entries={[menuItem("a", "Alpha", vi.fn())]} anchor={menu.anchor} onClose={menu.close} />}
          </>
        );
      }
      render(<Touch />);
      const el = screen.getByTestId("t");
      fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.touchEnd(el);
      fireEvent.click(el);
      expect(onClick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open when the finger moves (scrolling)", () => {
    vi.useFakeTimers();
    try {
      render(<Harness entries={[menuItem("a", "Alpha", vi.fn())]} />);
      const el = screen.getByTestId("target");
      fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] });
      fireEvent.touchMove(el, { touches: [{ clientX: 10, clientY: 60 }] });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      });
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("by default a second right-click on the trigger opens the menu again at the new point", async () => {
    render(<Harness entries={[menuItem("a", "Alpha", vi.fn())]} />);
    const target = screen.getByTestId("target");
    fireEvent.contextMenu(target, { clientX: 10, clientY: 10 });
    await act(() => new Promise((r) => setTimeout(r, 5)));
    fireEvent.pointerDown(target, { button: 2 });
    fireEvent.contextMenu(target, { clientX: 30, clientY: 30 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("with `toggle` a second right-click on the trigger closes the menu; elsewhere it still closes it", async () => {
    function Toggle() {
      const menu = useContextMenu({ toggle: true });
      return (
        <div>
          <button type="button" data-testid="trigger" {...menu.triggerProps}>
            trigger
          </button>
          <button type="button">outside</button>
          {menu.open && menu.anchor && <ContextMenu entries={[menuItem("a", "Alpha", vi.fn(), { keepOpen: true })]} anchor={menu.anchor} onClose={menu.close} trigger={menu.trigger} label="Menu" />}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Toggle />);
    const trigger = screen.getByTestId("trigger");
    fireEvent.contextMenu(trigger, { clientX: 10, clientY: 10 });
    await act(() => new Promise((r) => setTimeout(r, 5)));
    // A choice that keeps the menu open, then the same button again (the right button's pointerdown comes first).
    await user.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(trigger, { button: 2 });
    fireEvent.contextMenu(trigger, { clientX: 12, clientY: 12 });
    expect(screen.queryByRole("menu")).toBeNull();
    // A third right-click opens it again; a click outside closes it.
    fireEvent.pointerDown(trigger, { button: 2 });
    fireEvent.contextMenu(trigger, { clientX: 12, clientY: 12 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 5)));
    await user.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("reaches the control of a custom entry with the arrow keys and leaves its left/right keys alone", async () => {
    const user = userEvent.setup();
    const entries: MenuEntry[] = [
      menuItem("a", "Alpha", vi.fn()),
      { kind: "custom", id: "slider", render: () => <input type="range" aria-label="Level" min={0} max={10} defaultValue={5} /> },
      menuItem("b", "Beta", vi.fn()),
    ];
    render(<Harness entries={entries} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const slider = screen.getByRole("slider", { name: "Level" });
    expect(slider).toHaveFocus();
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "b"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => {
        slider.dispatchEvent(event);
      });
      expect(event.defaultPrevented, key).toBe(false);
      expect(slider).toHaveFocus();
    }
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Beta" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
    // Escape still closes from the control.
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
