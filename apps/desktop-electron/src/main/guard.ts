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

/**
 * Permissions the bundled client gets in the main window (Electron's names): `media` (the microphone and the camera),
 * writing to the clipboard, fullscreen, choosing the speaker. Screen capture is not a permission here: it goes through
 * the shell's picker (`capture.ts`).
 */
export const GRANTED: readonly string[] = ["media", "clipboard-sanitized-write", "fullscreen", "speaker-selection"];

/**
 * The answer to a permission request or check: `origin` is the requesting frame's URL or origin, `mainWindow` whether
 * it belongs to the main window, `mediaTypes` what a `media` request asks for (only `audio` and `video` are granted).
 */
export function permission(name: string, origin: string, mainWindow: boolean, devUrl: string | null, mediaTypes: readonly string[] = []): boolean {
  if (!mainWindow || !GRANTED.includes(name) || !isAppPage(origin, devUrl)) return false;
  return name !== "media" || mediaTypes.every((t) => t === "audio" || t === "video");
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

/**
 * The decision for a navigation of the sign-in window or one of its frames (docs/DESKTOP.md "Signing in"): the node's
 * page and wherever single sign-on sends it (https; plain http only on this computer), never the bundled client and
 * never `app:`, `file:`, `data:`, `javascript:` or `blob:` URLs.
 */
export function connectNavigation(url: string, devUrl: string | null): Navigation {
  if (isAppPage(url, devUrl)) return { kind: "deny" };
  const u = parse(url);
  if (!u) return { kind: "deny" };
  if (u.protocol === "https:" && u.hostname) return { kind: "allow" };
  if (u.protocol === "http:" && DEV_HOSTS_HTTP.includes(u.hostname)) return { kind: "allow" };
  if (u.protocol === "about:" && (u.pathname === "blank" || u.pathname === "srcdoc")) return { kind: "allow" };
  if (u.protocol === "http:" || u.protocol === "mailto:") return { kind: "external", url: u.href };
  return { kind: "deny" };
}

/** Hosts reached over plain http: a node in development mode on this computer. */
const DEV_HOSTS_HTTP: readonly string[] = ["localhost", "127.0.0.1"];

/** Why `openConnect` refused a URL. */
export type ConnectUrlError = "invalid" | "other_origin";

const b64url43 = (v: string) => /^[A-Za-z0-9_-]{43}$/.test(v);

/**
 * `openConnect`: the chosen node's sign-in page for an app session,
 * `<web origin>/connect?session=<43 characters of base64url>[&state=…][&mode=register][&method=passkey|sso]` with an
 * optional fragment `#k=<43 characters of base64url>` (the app's key for sealed unlock material, FEDERATION.md §8
 * step 3), nothing else. Returns the URL or the refusal.
 */
export function connectUrl(url: string, web: string): { ok: true; url: string } | { ok: false; error: ConnectUrlError } {
  const u = parse(url);
  const w = parse(web);
  if (!u || !w) return { ok: false, error: "invalid" };
  if (u.origin !== w.origin || u.origin === "null" || !["https:", "http:"].includes(u.protocol)) return { ok: false, error: "other_origin" };
  if (u.protocol === "http:" && !DEV_HOSTS_HTTP.includes(u.hostname)) return { ok: false, error: "invalid" };
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : null;
  const fragmentOk = hash === null || (hash.startsWith("k=") && b64url43(hash.slice(2)));
  if (u.pathname !== "/connect" || !fragmentOk || u.username || u.password) return { ok: false, error: "invalid" };
  let session = false;
  let method = false;
  for (const [key, value] of u.searchParams) {
    if (key === "session" && b64url43(value) && !session) session = true;
    else if (key === "state" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)) continue;
    else if (key === "mode" && value === "register") continue;
    else if (key === "method" && (value === "passkey" || value === "sso") && !method) method = true;
    else return { ok: false, error: "invalid" };
  }
  return session ? { ok: true, url: u.href } : { ok: false, error: "invalid" };
}
