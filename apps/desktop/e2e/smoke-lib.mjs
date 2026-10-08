// SPDX-License-Identifier: Apache-2.0
/** Helpers of the WebDriver smoke test (smoke.mjs), kept apart so `node --test` can check them. */

/**
 * The environment of the processes the test starts: GTK on X11 and no WAYLAND_DISPLAY, so the app renders on xvfb's
 * X display (WSLg sets WAYLAND_DISPLAY, and GTK prefers Wayland: the windows would open on the desktop).
 */
export function childEnv(base, extra = {}) {
  const env = { ...base, ...extra, GDK_BACKEND: "x11" };
  delete env.WAYLAND_DISPLAY;
  return env;
}

/** The node's `/` is its web client, not the placeholder of a node built without one (or a debug build whose tree is gone). */
export function servesWebClient(html) {
  return !/Web client not embedded/.test(html) && /<html/i.test(html);
}

/** `pgrep -f -x` pattern of the app binary with any arguments (regex characters of the path escaped). */
export function appProcessPattern(app) {
  return `${app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( .*)?`;
}
