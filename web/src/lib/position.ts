// SPDX-License-Identifier: Apache-2.0
/**
 * Placement of floating elements (profile cards, context menus) with collision handling: the element is
 * put next to its anchor on the preferred side, flipped to the opposite side when it does not fit, and
 * shifted so that it always stays inside the viewport (with a margin). Taller elements get a `maxHeight`
 * and scroll internally. Pure, so the math is unit-tested; {@link useFloating} applies it.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "right" | "left" | "bottom" | "top";

export interface Placement {
  left: number;
  top: number;
  /** The element must not be taller than this (it scrolls inside). */
  maxHeight: number;
  /** The element must not be wider than this. */
  maxWidth: number;
  /** The side of the anchor the element ended up on. */
  side: Side;
}

export interface PlaceOptions {
  /** `right`: beside the anchor (cards, submenus); `bottom`: below it (menus, context menus at the pointer). */
  prefer?: "right" | "bottom";
  /** Distance to the anchor. */
  gap?: number;
  /** Minimum distance to the viewport edges. */
  margin?: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

/** A zero-size anchor at a point (the pointer position of a right-click or long-press). */
export function pointAnchor(x: number, y: number): AnchorRect {
  return { left: x, top: y, right: x, bottom: y };
}

/** The anchor rectangle of an element. */
export function rectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export function placeFloating(anchor: AnchorRect, size: Size, viewport: Size, opts: PlaceOptions = {}): Placement {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 8;
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const maxHeight = Math.max(0, viewport.height - 2 * margin);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  const maxLeft = Math.max(margin, viewport.width - margin - width);
  const maxTop = Math.max(margin, viewport.height - margin - height);
  if ((opts.prefer ?? "right") === "right") {
    let side: Side = "right";
    let left = anchor.right + gap;
    if (left + width > viewport.width - margin) {
      const flipped = anchor.left - gap - width;
      // Flip only when the other side has room; otherwise the element is shifted over the anchor.
      if (flipped >= margin) {
        left = flipped;
        side = "left";
      }
    }
    return { left: clamp(left, margin, maxLeft), top: clamp(anchor.top, margin, maxTop), maxHeight, maxWidth, side };
  }
  let side: Side = "bottom";
  let top = anchor.bottom + gap;
  if (top + height > viewport.height - margin) {
    const above = anchor.top - gap - height;
    const spaceBelow = viewport.height - margin - anchor.bottom;
    const spaceAbove = anchor.top - margin;
    if (above >= margin || spaceAbove > spaceBelow) {
      top = above;
      side = "top";
    }
  }
  return { left: clamp(anchor.left, margin, maxLeft), top: clamp(top, margin, maxTop), maxHeight, maxWidth, side };
}

/** Is an element of `size` at `p` completely inside the viewport? */
export function insideViewport(p: { left: number; top: number }, size: Size, viewport: Size): boolean {
  return p.left >= 0 && p.top >= 0 && p.left + size.width <= viewport.width && p.top + size.height <= viewport.height;
}

/**
 * Positions `ref` (rendered with `position: fixed`) at `anchor` once it rendered (its size is measured),
 * and again when the window is resized or `deps` change (content loaded). Until it is measured it stays
 * invisible, so it never flashes at a wrong place.
 */
export function useFloating(ref: RefObject<HTMLElement | null>, anchor: AnchorRect | null, opts: PlaceOptions = {}, deps: unknown[] = []): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", left: 0, top: 0, visibility: "hidden" });
  const { prefer, gap, margin } = opts;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const place = () => {
      // The natural size (scrollHeight ignores the max-height of the previous placement).
      const p = placeFloating(anchor, { width: el.offsetWidth, height: el.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, { prefer, gap, margin });
      setStyle({ position: "fixed", left: p.left, top: p.top, maxHeight: p.maxHeight, maxWidth: p.maxWidth, visibility: "visible" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
    // The anchor is compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, anchor?.left, anchor?.top, anchor?.right, anchor?.bottom, prefer, gap, margin, ...deps]);
  return style;
}
