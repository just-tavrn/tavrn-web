// SPDX-License-Identifier: Apache-2.0
/**
 * What the main window may show and use (docs/DESKTOP.md "Security of the shell"; the decisions of the Tauri shell's
 * `guard.rs` with the app's own origin `app://tavrn`): only the bundled client. The app never loads remote pages, so a
 * node can never reach the bridge. Navigations elsewhere are refused; web links (http, https, mailto) open in the
 * system browser instead. The click-to-play embeds of the client (CSP `frame-src`) load in their frames. New windows
 * are never opened.
 *
 * Permissions: the main window's own pages get the microphone and the camera without a prompt (it shows only the
 * bundled client), and the few web permissions the client needs to work as in a browser (writing to the clipboard,
 * fullscreen video, choosing the speaker); everything else is denied, for every page. Screen capture goes through the
 * shell's own picker (`setDisplayMediaRequestHandler`), not through a permission.
 */
import { isAppUrl } from "./protocol.ts";

/** Hosts of the click-to-play embeds (`web/src/lib/embeds.ts`, CSP `frame-src`): their frames navigate inside the page. */
export const EMBED_HOSTS: readonly string[] = ["www.youtube-nocookie.com", "player.twitch.tv", "clips.twitch.tv", "player.vimeo.com", "open.spotify.com"];

export type Navigation = { kind: "allow" } | { kind: "external"; url: string } | { kind: "deny" };

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The bundled client: `app://tavrn`, or the Vite dev server in development (`devUrl`, never in a packaged app). */
export function isAppPage(url: string, devUrl: string | null): boolean {
  if (isAppUrl(url)) return true;
  if (!devUrl) return false;
  const u = parse(url);
  const d = parse(devUrl);
  return !!u && !!d && u.origin === d.origin && u.origin !== "null";
}

/** A link the system browser may open: http, https, mailto. */
export function externalLink(url: string): string | null {
  const u = parse(url);
  return u && ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
}

/** The decision for a navigation of the main window or one of its frames. */
export function navigation(url: string, devUrl: string | null): Navigation {
  if (isAppPage(url, devUrl)) return { kind: "allow" };
  const u = parse(url);
  if (!u) return { kind: "deny" };
  if (u.protocol === "about:" && (u.pathname === "blank" || u.pathname === "srcdoc")) return { kind: "allow" };
  if (u.protocol === "https:" && EMBED_HOSTS.includes(u.hostname)) return { kind: "allow" };
  const link = externalLink(url);
  return link ? { kind: "external", url: link } : { kind: "deny" };
}

/** New windows (`window.open`, `target=_blank`) are never opened by the app; web links go to the system browser. */
export function newWindow(url: string): string | null {
  return externalLink(url);
}

/** Permissions the bundled client gets in the main window (Electron's permission names). */
const GRANTED: readonly string[] = ["media", "clipboard-sanitized-write", "fullscreen", "speaker-selection"];

/**
 * The answer to a permission request or check: `origin` is the requesting frame's URL or origin, `mainWindow` whether
 * it belongs to the main window.
 */
export function permission(name: string, origin: string, mainWindow: boolean, devUrl: string | null): boolean {
  return mainWindow && GRANTED.includes(name) && isAppPage(origin, devUrl);
}

/**
 * The Vite dev server of `pnpm dev` (TAVRN_DESKTOP_DEV_URL), only in a development run (never in a packaged app) and
 * only on this computer.
 */
export function devServerUrl(packaged: boolean, value: string | undefined): string | null {
  if (packaged || !value) return null;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return u.origin;
  } catch {
    // ignored: refused below
  }
  console.error(`tavrn: ignoring TAVRN_DESKTOP_DEV_URL=${value} (only http://localhost:<port> or http://127.0.0.1:<port>)`);
  return null;
}
