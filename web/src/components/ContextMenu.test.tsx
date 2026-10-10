// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, LONG_PRESS_MS, MenuButton, findEntry, menuItem, normalizeMenu, separator, staysOpen, submenu, useContextMenu, type MenuEntry } from "./ContextMenu";

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

  it("keeps the menu open after a checkbox item by default; plain items and an explicit keepOpen: false close it", async () => {
    expect(staysOpen(menuItem("a", "A", undefined))).toBe(false);
    expect(staysOpen(menuItem("a", "A", undefined, { checked: false }))).toBe(true);
    expect(staysOpen(menuItem("a", "A", undefined, { checked: true, keepOpen: false }))).toBe(false);
    expect(staysOpen(menuItem("a", "A", undefined, { keepOpen: true }))).toBe(true);
    const user = userEvent.setup();
    const toggle = vi.fn();
    const plain = vi.fn();
    const forced = vi.fn();
    render(<Harness entries={[menuItem("c", "Check", toggle, { checked: false }), menuItem("f", "Forced", forced, { checked: true, keepOpen: false }), menuItem("p", "Plain", plain)]} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Check" }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Plain" }));
    expect(plain).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Forced" }));
    expect(forced).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  /** A notification-like menu whose entries follow the state they change (like the room menu). */
  function Stateful({ onSettings }: { onSettings: () => void }) {
    const menu = useContextMenu();
    const [mode, setMode] = useState("all");
    const [muted, setMuted] = useState(false);
    const entries = normalizeMenu([
      submenu("notify", "Notifications", ["all", "mentions", "nothing"].map((m) => menuItem(`mode-${m}`, m, () => setMode(m), { checked: mode === m }))),
      muted ? menuItem("unmute", "Unmute", () => setMuted(false), { keepOpen: true }) : submenu("mute", "Mute", [menuItem("mute-1", "For 1 hour", () => setMuted(true), { keepOpen: true })]),
      menuItem("settings", "Settings", onSettings),
    ]);
    return (
      <div>
        <MenuButton menu={menu} label="More" />
        {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label="Menu" />}
      </div>
    );
  }

  it("keeps an open submenu after a state change and shows the new state; navigation still closes", async () => {
    const user = userEvent.setup();
    const settings = vi.fn();
    render(<Stateful onSettings={settings} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Notifications" }));
    const sub = screen.getByTestId("context-submenu");
    expect(within(sub).getByRole("menuitemcheckbox", { name: "all" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(sub).getByRole("menuitemcheckbox", { name: "mentions" }));
    expect(screen.getByTestId("context-submenu")).toBeInTheDocument();
    expect(within(screen.getByTestId("context-submenu")).getByRole("menuitemcheckbox", { name: "mentions" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByTestId("context-submenu")).getByRole("menuitemcheckbox", { name: "all" })).toHaveAttribute("aria-checked", "false");
    // Keyboard: Enter on another mode keeps the menu open as well.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(within(screen.getByTestId("context-submenu")).getByRole("menuitemcheckbox", { name: "nothing" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(settings).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves the focus to the entry that replaces a vanished submenu (mute → unmute) and does not reopen it later", async () => {
    const user = userEvent.setup();
    render(<Stateful onSettings={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "For 1 hour" })).toHaveFocus();
    await user.keyboard("{Enter}");
    // The mute submenu is gone, the menu stays open with "Unmute" in its place, focused.
    expect(screen.queryByTestId("context-submenu")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Unmute" })).toHaveFocus();
    await user.keyboard("{Enter}");
    // The mute submenu is back as a closed entry; it does not pop open again by itself.
    expect(screen.getByRole("menuitem", { name: "Mute" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Mute" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("context-submenu")).toBeNull();
  });

  it("an entry that replaces the chosen one under the pointer (a tap on unmute) does not open its submenu by hover", async () => {
    const user = userEvent.setup();
    const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
    render(<Stateful onSettings={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.keyboard("{ArrowDown}{ArrowRight}{Enter}");
    await wait(400);
    await user.click(screen.getByRole("menuitem", { name: "Unmute" }));
    // The browser sends the pointer's hover to the new entry at the same place: no submenu pops up.
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Mute" }));
    expect(screen.queryByTestId("context-submenu")).toBeNull();
    // A real hover a moment later still opens it.
    await wait(400);
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Mute" }));
    expect(screen.getByTestId("context-submenu")).toBeInTheDocument();
  });
});
