// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { HotkeyHolds } from "./hotkeyHolds";

/** Holds with a focus flag the test switches; `log` collects the transitions. */
function holds() {
  const log: string[] = [];
  let focused = true;
  const h = new HotkeyHolds((action, held) => log.push(`${action} ${held ? "on" : "off"}`), () => focused);
  return { h, log, focus: (f: boolean) => (focused = f) };
}

describe("hotkey holds: the window's keys and the shell's observed keys as one", () => {
  it("in the browser the window's key alone: press and release", () => {
    const { h, log } = holds();
    h.window("push_to_talk", true);
    h.window("push_to_talk", true);
    expect(h.held("push_to_talk")).toBe(true);
    h.window("push_to_talk", false);
    expect(log).toEqual(["push_to_talk on", "push_to_talk off"]);
  });

  it("a tap in the focused window that the shell also reports fires once (a toggle never toggles twice)", () => {
    const { h, log } = holds();
    // The shell's report may come before or after the window's events.
    h.window("toggle_mute", true);
    h.window("toggle_mute", false);
    h.global("toggle_mute", true);
    h.global("toggle_mute", false);
    h.global("toggle_mute", true);
    h.window("toggle_mute", true);
    h.global("toggle_mute", false);
    h.window("toggle_mute", false);
    expect(log).toEqual(["toggle_mute on", "toggle_mute off", "toggle_mute on", "toggle_mute off"]);
  });

  it("in the background only the shell's keys count", () => {
    const { h, log, focus } = holds();
    focus(false);
    h.global("push_to_talk", true);
    h.global("push_to_talk", false);
    expect(log).toEqual(["push_to_talk on", "push_to_talk off"]);
  });

  it("a hold that started in the background survives focusing the window until its release", () => {
    const { h, log, focus } = holds();
    focus(false);
    h.global("push_to_talk", true);
    focus(true);
    // The window sees the release (its keyup) as well, the hold ends with the shell's release.
    h.window("push_to_talk", false);
    expect(h.held("push_to_talk")).toBe(true);
    h.global("push_to_talk", false);
    expect(log).toEqual(["push_to_talk on", "push_to_talk off"]);
  });

  it("leaving the window releases the window's keys, a key the shell still sees held stays held", () => {
    const { h, log, focus } = holds();
    h.window("priority", true);
    focus(false);
    h.blur();
    expect(log).toEqual(["priority on", "priority off"]);
    log.length = 0;
    // Held in the window and observed by the shell: switching to the game keeps push-to-talk open.
    focus(true);
    h.window("push_to_talk", true);
    h.global("push_to_talk", true);
    focus(false);
    h.blur();
    expect(h.held("push_to_talk")).toBe(true);
    h.global("push_to_talk", false);
    expect(log).toEqual(["push_to_talk on", "push_to_talk off"]);
  });

  it("release() ends a hold whatever holds it (a binding changed or the key listener stopped)", () => {
    const { h, log, focus } = holds();
    focus(false);
    h.global("push_to_talk", true);
    h.release("push_to_talk");
    h.release("push_to_talk");
    expect(log).toEqual(["push_to_talk on", "push_to_talk off"]);
    // The late release of the old binding changes nothing.
    h.global("push_to_talk", false);
    expect(log).toHaveLength(2);
  });
});
