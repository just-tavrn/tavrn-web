// SPDX-License-Identifier: Apache-2.0
/**
 * The client's side of the Android app (docs/ANDROID.md): the back gesture (close the open dialog or menu, else go
 * back in the client's history, else send the app to the background from its first page instead of closing it), the
 * system bars (CSS variables the layout pads itself with:
 * `--safe-top`, `--safe-right`, `--safe-bottom`, `--safe-left`, styles.css), and the Screen Orientation API, which
 * Android's webview does not implement (the shell locks natively; fullscreen itself is the webview's own Fullscreen
 * API since the shell's chrome client shows it, docs/ANDROID.md "Fullscreen"). Platform-independent: it takes the
 * Android member, so tests pass a fake.
 */
import type { AndroidInsets, PlatformAndroid } from "./types";

/** Open dialogs and menus close on Escape (the client's own handlers); the back gesture uses that. */
const LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Overlays without Escape handling (the navigation drawers) mark their closer with `data-back-close`. */
const CLOSER = "[data-back-close]";

/**
 * Closes the topmost dialog or menu with an Escape key press, else clicks the closer of an open drawer; false when
 * nothing is open.
 */
export function closeTopLayer(doc: Document = document): boolean {
  const layers = Array.from(doc.querySelectorAll<HTMLElement>(LAYER)).filter((el) => !el.closest("[hidden]") && el.getAttribute("aria-hidden") !== "true");
  const top = layers.at(-1);
  if (!top) {
    const closer = Array.from(doc.querySelectorAll<HTMLElement>(CLOSER)).at(-1);
    closer?.click();
    return !!closer;
  }
  const target = doc.activeElement instanceof HTMLElement && top.contains(doc.activeElement) ? doc.activeElement : top;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  return true;
}

/** Whether the client's history has a page to go back to (react-router keeps the index in `history.state`). */
export function canGoBack(history: Pick<History, "state"> = window.history): boolean {
  const idx = (history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

/** What the back gesture does. */
export function onBackGesture(android: Pick<PlatformAndroid, "background">, go: { back: () => void }, doc: Document = document, history: Pick<History, "state"> = window.history): "layer" | "back" | "background" {
  if (closeTopLayer(doc)) return "layer";
  if (canGoBack(history)) {
    go.back();
    return "back";
  }
  void android.background().catch(() => undefined);
  return "background";
}

/** The system bars as CSS variables on the root element (styles.css falls back to `env(safe-area-inset-*)`). */
export function applyInsets(insets: AndroidInsets, root: HTMLElement = document.documentElement): void {
  for (const side of ["top", "right", "bottom", "left"] as const) root.style.setProperty(`--safe-${side}`, `${Math.max(0, insets[side])}px`);
  root.style.setProperty("--keyboard", `${Math.max(0, insets.keyboard)}px`);
}

type LockableOrientation = ScreenOrientation & { lock?: (orientation: string) => Promise<void>; unlock?: () => void };

/**
 * `screen.orientation.lock()` and `unlock()` through the app where the webview refuses them (Android's webview has no
 * Screen Orientation lock): the client's fullscreen code (`voice/ui/fullscreen.tsx`) keeps using the standard API. The
 * app allows a lock only in fullscreen, as browsers do; a refusal rejects like the standard API. Returns the restorer.
 */
export function routeOrientationLock(android: Pick<PlatformAndroid, "lockOrientation">, orientation: LockableOrientation | undefined = typeof window === "undefined" ? undefined : (window.screen?.orientation as LockableOrientation | undefined)): () => void {
  if (!orientation) return () => {};
  const target = orientation;
  const saved = { lock: Object.getOwnPropertyDescriptor(target, "lock"), unlock: Object.getOwnPropertyDescriptor(target, "unlock") };
  const ownLock = target.lock?.bind(target);
  const ownUnlock = target.unlock?.bind(target);
  let native = false;
  const lock = async (wanted: string) => {
    try {
      if (!ownLock) throw new DOMException("No orientation lock.", "NotSupportedError");
      await ownLock(wanted);
      return;
    } catch (refused) {
      try {
        await android.lockOrientation(wanted);
        native = true;
      } catch {
        throw refused instanceof DOMException ? refused : new DOMException("The orientation cannot be locked here.", "NotSupportedError");
      }
    }
  };
  const unlock = () => {
    try {
      ownUnlock?.();
    } catch {
      /* not locked */
    }
    if (!native) return;
    native = false;
    void android.lockOrientation(null).catch(() => undefined);
  };
  Object.defineProperty(target, "lock", { configurable: true, writable: true, value: lock });
  Object.defineProperty(target, "unlock", { configurable: true, writable: true, value: unlock });
  return () => {
    // The instance's own members again, or the prototype's, which these shadowed.
    for (const key of ["lock", "unlock"] as const) {
      const before = saved[key];
      if (before) Object.defineProperty(target, key, before);
      else Reflect.deleteProperty(target, key);
    }
  };
}

export interface AndroidShellOptions {
  android: PlatformAndroid;
  back: () => void;
}

/** Starts the wiring (links: `DeepLinkPrompt`); returns the stopper. */
export function startAndroidShell({ android, back }: AndroidShellOptions): () => void {
  applyInsets(android.insets());
  const stops = [routeOrientationLock(android), android.onInsets((insets) => applyInsets(insets)), android.onBack(() => void onBackGesture(android, { back }))];
  return () => stops.forEach((stop) => stop());
}
