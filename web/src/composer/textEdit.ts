// SPDX-License-Identifier: Apache-2.0
/**
 * Programmatic edits of the composer's textarea (formatting, completions, emojis) without `execCommand`: only the
 * changed range is replaced with `setRangeText` and an `input` event lets React's `onChange` pick the value up, so
 * React never reassigns `value` (which would reset the browser's undo history). Browsers do not record
 * `setRangeText` in their undo history, so the composer keeps its own for these edits ({@link useEditHistory}):
 * Ctrl/Cmd+Z right after one restores the text and selection before it, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes it; once
 * the user types, the browser's own undo takes over again.
 */
import { useCallback, useRef, type KeyboardEvent, type RefObject } from "react";
import type { TextState } from "./format";

/** Replaces the textarea's text with `next.value` (only the changed range) and selects `next.start`…`next.end`. */
export function replaceText(el: HTMLTextAreaElement, next: TextState): void {
  const old = el.value;
  const target = next.value;
  let from = 0;
  while (from < old.length && from < target.length && old[from] === target[from]) from++;
  let oldEnd = old.length;
  let newEnd = target.length;
  while (oldEnd > from && newEnd > from && old[oldEnd - 1] === target[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (old !== target) {
    if (typeof el.setRangeText === "function") el.setRangeText(target.slice(from, newEnd), from, oldEnd, "preserve");
    else Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, target);
  }
  el.setSelectionRange(next.start, next.end);
  if (old !== target) el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The textarea's text and selection. */
export function textState(el: HTMLTextAreaElement): TextState {
  return { value: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
}

interface Step {
  before: TextState;
  after: TextState;
}

const MAX_STEPS = 100;

/** Applies programmatic edits and undoes/redoes them with the usual shortcuts. */
export function useEditHistory(textarea: RefObject<HTMLTextAreaElement | null>) {
  const undo = useRef<Step[]>([]);
  const redo = useRef<Step[]>([]);

  /** Replaces the text (see {@link replaceText}) as one undoable step; returns false without a textarea. */
  const apply = useCallback(
    (next: TextState): boolean => {
      const el = textarea.current;
      if (!el) return false;
      const before = textState(el);
      if (before.value === next.value && before.start === next.start && before.end === next.end) return true;
      replaceText(el, next);
      undo.current.push({ before, after: next });
      if (undo.current.length > MAX_STEPS) undo.current.shift();
      redo.current = [];
      return true;
    },
    [textarea],
  );

  /** Handles Ctrl/Cmd+Z and redo for the composer's own edits; true when it did (the event is consumed). */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const el = textarea.current;
      if (!el || !(e.ctrlKey || e.metaKey) || e.altKey) return false;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
      if (isUndo) {
        const step = undo.current.at(-1);
        // Typed since: the browser's undo history is in charge.
        if (!step || step.after.value !== el.value) {
          undo.current = [];
          redo.current = [];
          return false;
        }
        e.preventDefault();
        undo.current.pop();
        replaceText(el, step.before);
        redo.current.push(step);
        return true;
      }
      if (isRedo) {
        const step = redo.current.at(-1);
        if (!step || step.before.value !== el.value) return false;
        e.preventDefault();
        redo.current.pop();
        replaceText(el, step.after);
        undo.current.push(step);
        return true;
      }
      return false;
    },
    [textarea],
  );

  return { apply, onKeyDown };
}
