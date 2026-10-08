// SPDX-License-Identifier: Apache-2.0
/**
 * The recorder behind "Change" of a hotkey (issue #36): one key of any kind, a modifier alone, or modifiers and a key,
 * stored in the shell's canonical spelling (`Ctrl+Alt+Shift+Super+<KeyboardEvent.code>`, a lone modifier as its own
 * code: `ControlLeft`). A key that is not a modifier ends the recording on its keydown; a modifier counts alone when
 * it is released without another key in between. Plain Escape cancels, plain Backspace removes the binding.
 */

export type RecorderKey = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat">;

export type RecorderStep = { kind: "partial"; held: string } | { kind: "done"; combo: string } | { kind: "cancel" } | { kind: "clear" };

/** The modifier keys that can be bound alone (as `KeyboardEvent.code` spells them). */
export const MODIFIER_KEYS = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"] as const;

/** Keys that only modify; the recorder waits for the real key (or for their release). */
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS|Super|Hyper)(Left|Right)?$|^(AltGraph|Fn|FnLock)$/;

/** Older browsers spell the Windows/Super key `OSLeft`. */
export function normalizeCode(code: string): string {
  return code === "OSLeft" ? "MetaLeft" : code === "OSRight" ? "MetaRight" : code;
}

/** The modifiers held, as the prefix of a combination: `Ctrl+Shift+`. */
export function heldModifiers(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  return `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.metaKey ? "Super+" : ""}`;
}

export class ComboRecorder {
  /** Modifier keys down since the recording started. */
  private readonly down_ = new Set<string>();
  /** More than one modifier, or a key, was pressed: no lone modifier any more until all are up. */
  private spoiled = false;

  down(e: RecorderKey): RecorderStep | null {
    const code = normalizeCode(e.code);
    if (!code || e.repeat) return null;
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    if (plain && code === "Escape") return { kind: "cancel" };
    if (plain && code === "Backspace") return { kind: "clear" };
    if (MODIFIER_CODES.test(code)) {
      this.down_.add(code);
      if (this.down_.size > 1) this.spoiled = true;
      return { kind: "partial", held: heldModifiers(e) };
    }
    return { kind: "done", combo: `${heldModifiers(e)}${code}` };
  }

  up(e: RecorderKey): RecorderStep | null {
    const code = normalizeCode(e.code);
    if (!this.down_.has(code)) return null;
    const alone = !this.spoiled && this.down_.size === 1 && (MODIFIER_KEYS as readonly string[]).includes(code);
    this.down_.delete(code);
    if (alone) return { kind: "done", combo: code };
    if (this.down_.size === 0) this.spoiled = false;
    return { kind: "partial", held: heldModifiers(e) };
  }
}
