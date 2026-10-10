// SPDX-License-Identifier: Apache-2.0
// The navigation cases of apps/desktop/src-tauri/src/guard.rs with the app's own origin `app://tavrn`, and the
// permission decisions of the main window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { devServerUrl, externalLink, isAppPage, navigation, newWindow, permission } from "./guard.ts";

const dev = "http://localhost:5300";

test("the bundled client is the app", () => {
  for (const ok of ["app://tavrn/", "app://tavrn/rooms/1", "app://tavrn/login?x=1#y"]) assert.ok(isAppPage(ok, null), ok);
  for (const bad of ["app://evil/", "https://tavrn.example/", "app://tavrn.evil.example/", "http://localhost:5300/", "tauri://localhost/", "file:///index.html"]) {
    assert.ok(!isAppPage(bad, null), bad);
  }
});

test("the dev server only in development", () => {
  assert.ok(isAppPage("http://localhost:5300/node", dev));
  assert.ok(!isAppPage("http://localhost:5301/", dev));
  assert.ok(!isAppPage("http://localhost:5300/", null));
});

test("navigations away from the client open in the system browser", () => {
  assert.deepEqual(navigation("app://tavrn/login", null), { kind: "allow" });
  assert.deepEqual(navigation("https://tavrn.example/invite/abc", null), { kind: "external", url: "https://tavrn.example/invite/abc" });
  assert.deepEqual(navigation("mailto:abuse@tavrn.example", null), { kind: "external", url: "mailto:abuse@tavrn.example" });
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ftp://x.example/", "app://evil/", "blob:app://tavrn/abc", "not a url"]) {
    assert.deepEqual(navigation(bad, null), { kind: "deny" }, bad);
  }
});

test("embed frames and empty frames load", () => {
  for (const ok of ["https://www.youtube-nocookie.com/embed/x", "https://player.vimeo.com/video/1", "about:blank", "about:srcdoc"]) {
    assert.deepEqual(navigation(ok, null), { kind: "allow" }, ok);
  }
  assert.deepEqual(navigation("http://www.youtube-nocookie.com/embed/x", null), { kind: "external", url: "http://www.youtube-nocookie.com/embed/x" });
});

test("new windows never open in the app", () => {
  assert.equal(newWindow("https://example.org/"), "https://example.org/");
  assert.equal(newWindow("app://tavrn/rooms"), null);
  assert.equal(newWindow("file:///etc/passwd"), null);
});

test("openExternal accepts web links only", () => {
  assert.equal(externalLink("https://example.org/a?b#c"), "https://example.org/a?b#c");
  assert.equal(externalLink("mailto:x@example.org"), "mailto:x@example.org");
  for (const bad of ["", "/relative", "javascript:alert(1)", "file:///etc/passwd", "smb://host/share", "app://tavrn/", "tauri://localhost/"]) {
    assert.equal(externalLink(bad), null, bad);
  }
});

test("the main window gets the microphone, the camera and what the client needs; everything else is denied", () => {
  const app = "app://tavrn/rooms/1";
  for (const p of ["media", "clipboard-sanitized-write", "fullscreen", "speaker-selection"]) assert.equal(permission(p, app, true, null), true, p);
  for (const p of ["notifications", "geolocation", "midi", "midiSysex", "pointerLock", "keyboardLock", "openExternal", "clipboard-read", "display-capture", "idle-detection", "window-management", "unknown", "fileSystem", "storage-access"]) {
    assert.equal(permission(p, app, true, null), false, p);
  }
  // Not the main window, or a frame of another origin (an embed), or a page that is not the app: nothing.
  assert.equal(permission("media", app, false, null), false);
  assert.equal(permission("media", "https://www.youtube-nocookie.com/embed/x", true, null), false);
  assert.equal(permission("media", "http://localhost:5300/", true, null), false);
  assert.equal(permission("media", "http://localhost:5300/", true, dev), true);
});

test("the dev server comes from TAVRN_DESKTOP_DEV_URL only in a development run and only on this computer", () => {
  assert.equal(devServerUrl(false, "http://localhost:5300"), "http://localhost:5300");
  assert.equal(devServerUrl(false, "http://127.0.0.1:5300/node"), "http://127.0.0.1:5300");
  assert.equal(devServerUrl(false, undefined), null);
  assert.equal(devServerUrl(true, "http://localhost:5300"), null, "never in a packaged app");
  for (const bad of ["https://evil.example", "http://evil.example:5300", "file:///tmp/index.html", "javascript:1", "nonsense"]) assert.equal(devServerUrl(false, bad), null, bad);
});
