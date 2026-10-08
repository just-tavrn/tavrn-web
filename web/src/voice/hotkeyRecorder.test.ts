// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ComboRecorder, type RecorderKey } from "./hotkeyRecorder";

const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}, repeat = false): RecorderKey => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat, ...mods });

describe("the hotkey recorder", () => {
  it("a plain key at once, also one that types text", () => {
    expect(new ComboRecorder().down(key("KeyV"))).toEqual({ kind: "done", combo: "KeyV" });
    expect(new ComboRecorder().down(key("F13"))).toEqual({ kind: "done", combo: "F13" });
    expect(new ComboRecorder().down(key("Space"))).toEqual({ kind: "done", combo: "Space" });
  });

  it("a modifier alone: recorded when it is released without another key", () => {
    const r = new ComboRecorder();
    expect(r.down(key("ControlLeft", { ctrlKey: true }))).toEqual({ kind: "partial", held: "Ctrl+" });
    expect(r.down(key("ControlLeft", { ctrlKey: true }, true))).toBeNull();
    expect(r.up(key("ControlLeft"))).toEqual({ kind: "done", combo: "ControlLeft" });
    const right = new ComboRecorder();
    right.down(key("ShiftRight", { shiftKey: true }));
    expect(right.up(key("ShiftRight"))).toEqual({ kind: "done", combo: "ShiftRight" });
    // The older spelling of the Windows/Super key.
    const os = new ComboRecorder();
    os.down(key("OSLeft", { metaKey: true }));
    expect(os.up(key("OSLeft"))).toEqual({ kind: "done", combo: "MetaLeft" });
  });

  it("modifiers and a key: the combination as before", () => {
    const r = new ComboRecorder();
    r.down(key("ControlLeft", { ctrlKey: true }));
    expect(r.down(key("ShiftLeft", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "partial", held: "Ctrl+Shift+" });
    expect(r.down(key("KeyM", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "done", combo: "Ctrl+Shift+KeyM" });
    expect(new ComboRecorder().down(key("Digit1", { metaKey: true, altKey: true, ctrlKey: true, shiftKey: true }))).toEqual({ kind: "done", combo: "Ctrl+Alt+Shift+Super+Digit1" });
  });

  it("two modifiers without a key record nothing and start over when all are up", () => {
    const r = new ComboRecorder();
    r.down(key("ControlLeft", { ctrlKey: true }));
    r.down(key("AltRight", { ctrlKey: true, altKey: true }));
    expect(r.up(key("AltRight", { ctrlKey: true }))).toEqual({ kind: "partial", held: "Ctrl+" });
    expect(r.up(key("ControlLeft"))).toEqual({ kind: "partial", held: "" });
    // A fresh lone modifier works afterwards.
    r.down(key("AltLeft", { altKey: true }));
    expect(r.up(key("AltLeft"))).toEqual({ kind: "done", combo: "AltLeft" });
  });

  it("Escape cancels, Backspace removes the binding; a key release from before the recording is ignored", () => {
    expect(new ComboRecorder().down(key("Escape"))).toEqual({ kind: "cancel" });
    expect(new ComboRecorder().down(key("Backspace"))).toEqual({ kind: "clear" });
    expect(new ComboRecorder().down(key("Escape", { ctrlKey: true }))).toEqual({ kind: "done", combo: "Ctrl+Escape" });
    expect(new ComboRecorder().up(key("ControlLeft"))).toBeNull();
    expect(new ComboRecorder().down(key(""))).toBeNull();
  });
});
