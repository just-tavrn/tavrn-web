// SPDX-License-Identifier: Apache-2.0
// The built Node-API module (pnpm run build): its validation, its errors and, on the X display of `xvfb-run -a` with
// xdotool, real key presses of the X server reaching the callback while nothing else does. Skipped before the module is
// built. The key presses run only under xvfb-run (its XAUTHORITY), never on a desktop's display.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const file = new URL("../keywatch.linux-x64-gnu.node", import.meta.url);
const built = existsSync(file);
const keywatch = built ? createRequire(import.meta.url)(file.pathname) : null;
const hasXdotool = (() => {
  try {
    execFileSync("xdotool", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const xvfb = !!process.env.DISPLAY && /xvfb-run/.test(process.env.XAUTHORITY ?? "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("refuses unknown key names and oversized filters", { skip: !built && "not built" }, () => {
  assert.throws(() => keywatch.setKeys(["keym"]), /keywatch\.invalid: unknown key "keym"/);
  assert.throws(() => keywatch.setKeys(["Ctrl+KeyM"]), /keywatch\.invalid/);
  assert.throws(() => keywatch.setKeys(Array(257).fill("KeyA")), /keywatch\.invalid: too many keys/);
  keywatch.setKeys(["ControlLeft", "KeyM", "F24"]);
  keywatch.setKeys([]);
  keywatch.stop();
  assert.equal(keywatch.isRunning(), false);
});

test("without an X display the listener is unavailable", { skip: !built && "not built" }, () => {
  const display = process.env.DISPLAY;
  process.env.DISPLAY = ":4242";
  try {
    assert.throws(() => keywatch.start(() => {}), /keywatch\.unavailable: no X display/);
    assert.equal(keywatch.isRunning(), false);
  } finally {
    if (display === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = display;
  }
});

test("reports presses and releases of the watched keys only", { skip: (!built && "not built") || (!xvfb && "not under xvfb-run") || (!hasXdotool && "no xdotool") }, async () => {
  const got = [];
  keywatch.setKeys(["ControlLeft"]);
  keywatch.start((code, pressed) => got.push([code, pressed]));
  try {
    assert.equal(keywatch.isRunning(), true);
    assert.throws(() => keywatch.start(() => {}), /keywatch\.running/);
    execFileSync("xdotool", ["keydown", "Control_L"]);
    execFileSync("xdotool", ["key", "a"]);
    execFileSync("xdotool", ["keyup", "Control_L"]);
    // The filter changes while the listener runs.
    keywatch.setKeys(["KeyV"]);
    execFileSync("xdotool", ["key", "v", "Control_L"]);
    for (let i = 0; i < 40 && got.length < 4; i++) await sleep(50);
  } finally {
    keywatch.stop();
  }
  assert.deepEqual(got, [
    ["ControlLeft", true],
    ["ControlLeft", false],
    ["KeyV", true],
    ["KeyV", false],
  ]);
  assert.equal(keywatch.isRunning(), false);
});
