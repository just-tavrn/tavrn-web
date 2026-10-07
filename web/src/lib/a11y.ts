// SPDX-License-Identifier: Apache-2.0
/** Small keyboard helpers of the ARIA widget patterns (docs/ACCESSIBILITY.md). */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Roving focus over the items (`selector`) inside the element the handler is attached to: arrow keys (both axes
 * unless `orientation` is given), Home and End move the focus; `activate` also clicks the item (tabs with
 * automatic activation). Returns whether the key was handled. The items manage `tabIndex` themselves (the
 * current one 0, the others -1).
 */
export function rovingKeyDown(e: ReactKeyboardEvent<HTMLElement>, selector: string, opts: { orientation?: "horizontal" | "vertical"; activate?: boolean } = {}): boolean {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index < 0 || items.length === 0) return false;
  const forward = opts.orientation === "vertical" ? ["ArrowDown"] : opts.orientation === "horizontal" ? ["ArrowRight"] : ["ArrowRight", "ArrowDown"];
  const back = opts.orientation === "vertical" ? ["ArrowUp"] : opts.orientation === "horizontal" ? ["ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
  let next: number | undefined;
  if (forward.includes(e.key)) next = index + 1;
  else if (back.includes(e.key)) next = index - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next === undefined) return false;
  e.preventDefault();
  const target = items[(next + items.length) % items.length]!;
  target.focus();
  if (opts.activate) target.click();
  return true;
}

/** WAI-ARIA tabs with automatic activation: attach as `onKeyDown` of the `role="tablist"`. */
export function tabListKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  rovingKeyDown(e, '[role="tab"]', { orientation: e.currentTarget.getAttribute("aria-orientation") === "vertical" ? "vertical" : "horizontal", activate: true });
}
