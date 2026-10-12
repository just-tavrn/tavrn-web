// SPDX-License-Identifier: Apache-2.0
/**
 * The client's side of the Android app (docs/ANDROID.md): the back gesture (close the open dialog or menu, else go
 * back in the client's history, else send the app to the background from its first page instead of closing it), app
 * links (invites and add links open in the app), and the system bars (CSS variables the layout pads itself with:
 * `--safe-top`, `--safe-right`, `--safe-bottom`, `--safe-left`, styles.css). Platform-independent: it takes the
 * Android member, so tests pass a fake.
 */
import { identityOfHost } from "@tavrn/sdk";
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

const CODE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * The client's route for an app link (already checked by the shell: `/invite/<code>`, `/add/<id>`,
 * `/add/<domain>/<id>`): the home node's own links as they are; another node's invite with `?node=<its identity
 * domain>`, another node's add link with its domain in the path. `identity` finds the identity domain of a web host
 * (delegation: `app.tavrn.org` belongs to `tavrn.org`).
 */
export async function linkRoute(link: string, home: { web: string; domain: string | null }, identity: (host: string) => Promise<string | null> = (h) => identityOfHost(h)): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const own = (() => {
    try {
      return new URL(home.web).origin === url.origin;
    } catch {
      return false;
    }
  })();
  const domain = own ? home.domain : ((await identity(url.hostname).catch(() => null)) ?? url.hostname);
  const local = own || (!!domain && domain === home.domain);
  const [kind, first, second] = segments;
  if (kind === "invite" && segments.length === 2 && first && CODE.test(first)) {
    return local ? `/invite/${first}` : `/invite/${first}?node=${encodeURIComponent(domain ?? url.hostname)}`;
  }
  if (kind === "add" && first && segments.length <= 3) {
    const room = url.searchParams.get("room");
    const query = room ? `?room=${encodeURIComponent(room)}` : "";
    if (second) return `/add/${first}/${second}${query}`;
    return local ? `/add/${first}${query}` : `/add/${domain ?? url.hostname}/${first}${query}`;
  }
  return null;
}

/** The system bars as CSS variables on the root element (styles.css falls back to `env(safe-area-inset-*)`). */
export function applyInsets(insets: AndroidInsets, root: HTMLElement = document.documentElement): void {
  for (const side of ["top", "right", "bottom", "left"] as const) root.style.setProperty(`--safe-${side}`, `${Math.max(0, insets[side])}px`);
  root.style.setProperty("--keyboard", `${Math.max(0, insets.keyboard)}px`);
}

export interface AndroidShellOptions {
  android: PlatformAndroid;
  navigate: (path: string) => void;
  back: () => void;
  home: () => { web: string; domain: string | null };
}

/** Starts the wiring; returns the stopper. */
export function startAndroidShell({ android, navigate, back, home }: AndroidShellOptions): () => void {
  applyInsets(android.insets());
  const stops = [
    android.onInsets((insets) => applyInsets(insets)),
    android.onBack(() => void onBackGesture(android, { back })),
    android.onLink((url) => {
      void linkRoute(url, home()).then((path) => path && navigate(path));
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
