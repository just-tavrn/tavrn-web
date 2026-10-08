// SPDX-License-Identifier: Apache-2.0
// node --test: the helpers of the WebDriver smoke test (smoke.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appProcessPattern, childEnv, servesWebClient } from "./smoke-lib.mjs";

test("the app renders on xvfb's X display, never on a Wayland desktop", () => {
  const env = childEnv({ DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", GDK_BACKEND: "wayland", PATH: "/usr/bin" }, { TAVRN_DESKTOP_KEYCHAIN: "memory" });
  assert.equal(env.GDK_BACKEND, "x11");
  assert.equal("WAYLAND_DISPLAY" in env, false);
  assert.equal(env.DISPLAY, ":99");
  assert.equal(env.TAVRN_DESKTOP_KEYCHAIN, "memory");
  assert.equal(env.PATH, "/usr/bin");
});

test("a node without its web client is recognized", () => {
  assert.equal(servesWebClient("Web client not embedded (web/dist missing at build time). The API runs under /api/v1."), false);
  assert.equal(servesWebClient(""), false);
  assert.equal(servesWebClient('<!doctype html><html lang="en"><head><title>tavrn</title></head><body><div id="root"></div></body></html>'), true);
});

test("running instances are matched by the exact app binary", () => {
  const re = new RegExp(`^${appProcessPattern("/opt/build.1/release/tavrn")}$`);
  assert.ok(re.test("/opt/build.1/release/tavrn"));
  assert.ok(re.test("/opt/build.1/release/tavrn --flag"));
  assert.ok(!re.test("/opt/buildX1/release/tavrn"), "dots are literal");
  assert.ok(!re.test("/opt/build.1/release/tavrn-node --dev"));
  assert.ok(!re.test("node smoke.mjs /opt/build.1/release/tavrn"));
});
