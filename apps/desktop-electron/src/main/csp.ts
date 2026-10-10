// SPDX-License-Identifier: Apache-2.0
/**
 * The Content Security Policy of the bundled client, sent with every page of `app://tavrn` (`protocol.ts`). It is the
 * Tauri shell's (`apps/desktop/src-tauri/tauri.conf.json`, `app.security.csp`; a unit test compares both) without
 * Tauri's IPC origins: scripts only from the bundle (`'self'` is `app://tavrn`) and WebAssembly, no eval, no inline
 * scripts, no third-party scripts; `connect-src` https and wss to any node plus plain http/ws to `localhost` and
 * `127.0.0.1` (development nodes); images and media from https; frames only for the click-to-play embed providers.
 * The Vite dev server (development only) is served without it: its hot reload needs inline scripts.
 */
export const CSP_DIRECTIVES: Readonly<Record<string, string>> = {
  "default-src": "'self'",
  "script-src": "'self' 'wasm-unsafe-eval'",
  "style-src": "'self' 'unsafe-inline'",
  "font-src": "'self'",
  "img-src": "'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
  "media-src": "'self' blob: https: http://localhost:* http://127.0.0.1:*",
  "connect-src": "'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
  "worker-src": "'self' blob:",
  "frame-src": "https://www.youtube-nocookie.com https://player.twitch.tv https://clips.twitch.tv https://player.vimeo.com https://open.spotify.com",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
};

/** The `Content-Security-Policy` header value. */
export function contentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}
