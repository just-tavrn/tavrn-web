// SPDX-License-Identifier: Apache-2.0
// The navigation cases of apps/desktop/src-tauri/src/guard.rs with the app's own origin `app://tavrn`, and the
// permission decisions of the main window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectNavigation, connectUrl, devServerUrl, externalLink, isAppPage, navigation, newWindow, permission } from "./guard.ts";

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
  // A media request names its types: the microphone and the camera, nothing else.
  assert.equal(permission("media", app, true, null, ["audio", "video"]), true);
  assert.equal(permission("media", "app://tavrn", true, null, ["audio"]), true);
  assert.equal(permission("media", app, true, null, ["audio", "screen"]), false);
});

test("the dev server comes from TAVRN_DESKTOP_DEV_URL only in a development run and only on this computer", () => {
  assert.equal(devServerUrl(false, "http://localhost:5300"), "http://localhost:5300");
  assert.equal(devServerUrl(false, "http://127.0.0.1:5300/node"), "http://127.0.0.1:5300");
  assert.equal(devServerUrl(false, undefined), null);
  assert.equal(devServerUrl(true, "http://localhost:5300"), null, "never in a packaged app");
  for (const bad of ["https://evil.example", "http://evil.example:5300", "file:///tmp/index.html", "javascript:1", "nonsense"]) assert.equal(devServerUrl(false, bad), null, bad);
});

test("the sign-in window follows the node and single sign-on, but never the app", () => {
  for (const ok of ["https://tavrn.example/connect?session=x", "https://login.idp.example/authorize?client_id=x", "http://127.0.0.1:8500/connect", "http://localhost:8080/sso/callback", "about:blank"]) {
    assert.deepEqual(connectNavigation(ok, null), { kind: "allow" }, ok);
  }
  for (const bad of ["app://tavrn/", "app://tavrn/login", "file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "blob:https://tavrn.example/abc", "ftp://x.example/", "tauri://localhost/"]) {
    assert.deepEqual(connectNavigation(bad, null), { kind: "deny" }, bad);
  }
  assert.deepEqual(connectNavigation("http://evil.example/", null), { kind: "external", url: "http://evil.example/" });
  assert.deepEqual(connectNavigation("http://localhost:5300/rooms", dev), { kind: "deny" }, "the dev server is the app");
});

test("openConnect takes only the node's sign-in page", () => {
  const s = "S".repeat(43);
  const state = "s".repeat(22);
  const web = "https://web.tavrn.example";
  const k = "K".repeat(43);
  for (const ok of [
    `${web}/connect?session=${s}`,
    `${web}/connect?session=${s}&state=${state}`,
    `${web}/connect?session=${s}&state=${state}&mode=register`,
    `${web}/connect?session=${s}&state=${state}&method=passkey`,
    `${web}/connect?session=${s}&state=${state}&method=sso`,
    `${web}/connect?session=${s}&state=${state}&method=passkey#k=${k}`,
    `${web}/connect?session=${s}&mode=register#k=${k}`,
  ]) {
    assert.ok(connectUrl(ok, web).ok, ok);
  }
  assert.ok(connectUrl(`http://127.0.0.1:8500/connect?session=${s}`, "http://127.0.0.1:8500").ok);
  for (const [bad, why] of [
    [`https://evil.example/connect?session=${s}`, "other_origin"],
    [`https://web.tavrn.example:8443/connect?session=${s}`, "other_origin"],
    [`http://web.tavrn.example/connect?session=${s}`, "other_origin"],
    [`app://tavrn/connect?session=${s}`, "other_origin"],
    [`${web}/login?session=${s}`, "invalid"],
    [`${web}/connect?session=short`, "invalid"],
    [`${web}/connect`, "invalid"],
    [`${web}/connect?session=${s}&origin=https://evil.example`, "invalid"],
    [`${web}/connect?session=${s}&session=${s}`, "invalid"],
    [`${web}/connect?session=${s}#x`, "invalid"],
    [`${web}/connect?session=${s}#`, "invalid"],
    [`${web}/connect?session=${s}#k=short`, "invalid"],
    [`${web}/connect?session=${s}#k=${k}&x=1`, "invalid"],
    [`${web}/connect?session=${s}#k=${"+".repeat(43)}`, "invalid"],
    [`${web}/connect?session=${s}&method=password`, "invalid"],
    [`${web}/connect?session=${s}&method=passkey&method=sso`, "invalid"],
    ["javascript:alert(1)", "other_origin"],
  ] as const) {
    assert.deepEqual(connectUrl(bad, web), { ok: false, error: why }, bad);
  }
  assert.deepEqual(connectUrl(`http://192.168.1.2/connect?session=${s}`, "http://192.168.1.2"), { ok: false, error: "invalid" });
});
