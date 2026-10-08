// SPDX-License-Identifier: Apache-2.0
/**
 * Whether a hotkey action is held, from two sources (issue #36): the window's own key events (the browser, and the
 * desktop app while its window has focus) and the shell's system-wide key listener (desktop app, every key of the
 * bindings, also while another program has the focus). While the window has focus both see the same key, at slightly
 * different times; counting both would toggle mute twice on one tap. So:
 *
 * - a press the shell reports while the window has focus is only noted ("shadow"); the window's own event counts;
 * - a press the shell reports while the window is in the background counts ("owned") until its release, whatever the
 *   focus does in between;
 * - leaving the window releases the window's keys (their keyup will not come) and turns a noted press of the shell into
 *   a counting one: the key is still down, now for the program in front.
 *
 * `onChange` hears every transition of an action: held, then released.
 */
import type { HotkeyAction } from "../platform";

type Global = "none" | "shadow" | "owned";

interface Hold {
  window: boolean;
  global: Global;
}

export class HotkeyHolds {
  private readonly holds = new Map<HotkeyAction, Hold>();

  constructor(
    private readonly onChange: (action: HotkeyAction, held: boolean) => void,
    private readonly focused: () => boolean,
  ) {}

  /** Whether `action` is held right now. */
  held(action: HotkeyAction): boolean {
    const h = this.holds.get(action);
    return !!h && (h.window || h.global === "owned");
  }

  /** The window's keydown (`pressed`) or keyup of the action's binding. */
  window(action: HotkeyAction, pressed: boolean): void {
    this.change(action, (h) => ({ ...h, window: pressed }));
  }

  /** A press or release reported by the shell's key listener. */
  global(action: HotkeyAction, pressed: boolean): void {
    this.change(action, (h) => ({ ...h, global: !pressed ? "none" : h.global === "owned" || !this.focused() ? "owned" : "shadow" }));
  }

  /** The window lost the focus. */
  blur(): void {
    for (const action of [...this.holds.keys()]) this.change(action, (h) => ({ window: false, global: h.global === "shadow" ? "owned" : h.global }));
  }

  /** Ends the hold of `action` from every source. */
  release(action: HotkeyAction): void {
    this.change(action, () => ({ window: false, global: "none" }));
  }

  /** Ends every hold. */
  releaseAll(): void {
    for (const action of [...this.holds.keys()]) this.release(action);
  }

  private change(action: HotkeyAction, next: (h: Hold) => Hold): void {
    const before = this.held(action);
    this.holds.set(action, next(this.holds.get(action) ?? { window: false, global: "none" }));
    const after = this.held(action);
    if (before !== after) this.onChange(action, after);
  }
}
