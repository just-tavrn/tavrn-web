// SPDX-License-Identifier: Apache-2.0
/**
 * How popovers and menus close (docs/ACCESSIBILITY.md, WCAG 2.4.3 and 1.4.13): a press outside (pointer, touch or
 * pen, in the capture phase, so content that stops propagation cannot keep it open), Escape, and optionally scrolling
 * or resizing (fixed-position popovers whose anchor moved) and the window losing the focus. Escape closes only the
 * innermost open layer and gives the focus back to the trigger; an Escape that something inside handled already
 * (`defaultPrevented`) is left alone, and the one handled here is marked, so a dialog underneath stays open.
 */
import { useEffect, useRef, type RefObject } from "react";

export interface DismissOptions {
  /** Elements that count as inside (the popover, its trigger): a press there does not close it. */
  inside?: Array<RefObject<Element | null>>;
  /** Escape gives the focus back to this element (the trigger: WAI-ARIA menu button and disclosure). */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Scrolling outside the popover and resizing the window close it. */
  closeOnScroll?: boolean;
  /** The window losing the focus closes it. */
  closeOnBlur?: boolean;
  /** A right-click outside closes it too (context menus). */
  contextMenu?: boolean;
  /** Listen only after the event that opened it has finished (a menu opened by a press or a right-click). */
  deferred?: boolean;
  /** An outside event that should not close it (e.g. a toggling trigger's own right-click). */
  ignore?: (e: Event) => boolean;
}

/** Open layers, innermost last: only the innermost one handles Escape. */
const layers: object[] = [];

export function useDismiss(open: boolean, onClose: () => void, opts: DismissOptions = {}): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    if (!open) return;
    const layer = {};
    layers.push(layer);
    const close = () => onCloseRef.current();
    const isInside = (target: EventTarget | null) => target instanceof Node && (optsRef.current.inside ?? []).some((r) => r.current?.contains(target));
    const outside = (e: Event) => {
      if (isInside(e.target) || optsRef.current.ignore?.(e)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || layers[layers.length - 1] !== layer) return;
      e.preventDefault();
      close();
      optsRef.current.returnFocus?.current?.focus({ preventScroll: true });
    };
    const onScroll = (e: Event) => {
      if (!isInside(e.target)) close();
    };
    const { closeOnScroll, closeOnBlur, contextMenu, deferred } = optsRef.current;
    const listen = () => {
      document.addEventListener("pointerdown", outside, true);
      if (contextMenu) document.addEventListener("contextmenu", outside, true);
    };
    // Registered after the opening event has finished, so the same press does not close it again.
    const timer = deferred ? setTimeout(listen, 0) : undefined;
    if (!deferred) listen();
    document.addEventListener("keydown", onKey);
    if (closeOnScroll) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
    }
    if (closeOnBlur) window.addEventListener("blur", close);
    return () => {
      clearTimeout(timer);
      layers.splice(layers.lastIndexOf(layer), 1);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("contextmenu", outside, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);
}
