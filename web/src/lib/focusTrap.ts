// SPDX-License-Identifier: Apache-2.0
/**
 * Focus handling of modal surfaces (WCAG 2.1.2, 2.4.3; docs/ACCESSIBILITY.md): while a dialog is open, Tab and
 * Shift+Tab cycle through its controls only, the first control (or the dialog itself) takes the focus on open and
 * the element that had the focus before gets it back on close.
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]",
].join(",");

// jsdom (unit tests) lays nothing out, so every element would count as hidden there.
const noLayout = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

/** Focusable, rendered descendants of `root` in tab order (positive tabindex is not used in the app). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.closest("[inert]") && (noLayout || el.getClientRects().length > 0));
}

/** Open traps, innermost last: only the topmost one handles Tab (a dialog opened from a dialog). */
const stack: HTMLElement[] = [];

/**
 * Keeps Tab inside `ref` while `active`. `initial` picks the element focused on open (default: the first
 * focusable one, else the container, which then needs `tabIndex={-1}`); `restore: false` skips returning the
 * focus on close (when the caller moves it elsewhere).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, opts: { initial?: () => HTMLElement | null | undefined; restore?: boolean } = {}) {
  const { restore = true } = opts;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root.contains(document.activeElement)) {
      const first = opts.initial?.() ?? focusableIn(root)[0] ?? root;
      first.focus({ preventScroll: true });
    }
    stack.push(root);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || stack[stack.length - 1] !== root || e.defaultPrevented) return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    // Focus that escapes (a click on the backdrop, a script) is pulled back on the next Tab by the handler above;
    // a Tab pressed while the focus is outside lands on the document, so listen there too.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && !root.contains(document.activeElement)) onKey(e);
    };
    document.addEventListener("keydown", onDocKey);
    return () => {
      stack.splice(stack.lastIndexOf(root), 1);
      root.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onDocKey);
      if (restore && previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
    // The options are read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
