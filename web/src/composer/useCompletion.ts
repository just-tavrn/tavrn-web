// SPDX-License-Identifier: Apache-2.0
/**
 * State of the composer's inline autocomplete (composer/autocomplete.ts): the trigger at the caret, its suggestions,
 * the selected row, Escape's dismissal (the list stays closed until the caret leaves that word) and the keys.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { applyCompletion, findTrigger, type CompletionProvider, type Suggestion, type Trigger } from "./autocomplete";
import type { TextState } from "./format";

export function useCompletion<T>({
  providers,
  value,
  caret,
  enabled,
  apply,
}: {
  providers: CompletionProvider<T>[];
  value: string;
  /** The caret, -1 while a range is selected. */
  caret: number;
  /** False while something else owns the keys (the command palette, its argument suggestions). */
  enabled: boolean;
  /** Writes the completed text and caret into the text box. */
  apply: (next: TextState) => void;
}) {
  const completion = useMemo(() => {
    if (!enabled || caret < 0) return null;
    // The trigger nearest to the caret wins (`#general @al…` completes the mention).
    let best: { provider: CompletionProvider<T>; trigger: Trigger } | null = null;
    for (const provider of providers) {
      const trigger = findTrigger(value, caret, provider.trigger);
      if (trigger && trigger.query.length >= (provider.minQuery ?? 0) && (!best || trigger.start > best.trigger.start)) best = { provider, trigger };
    }
    return best;
  }, [enabled, caret, providers, value]);
  // A word that already is a suggestion's text (case-insensitive: `/kick @alice`) is not offered again, so Enter sends
  // instead of re-picking it; the command arguments follow the same rule (Composer.tsx).
  const items = useMemo(() => {
    if (!completion) return [];
    const typed = value.slice(completion.trigger.start, completion.trigger.end).toLowerCase();
    return completion.provider.suggest(completion.trigger.query).filter((s) => s.insert.toLowerCase() !== typed);
  }, [completion, value]);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const open = !!completion && items.length > 0 && dismissedAt !== completion.trigger.start;
  useEffect(() => setSelected(0), [completion?.trigger.start, completion?.trigger.query]);
  useEffect(() => {
    if (!completion) setDismissedAt(null);
  }, [completion]);

  const pick = (trigger: Trigger, item: Suggestion<T>) => apply(applyCompletion(value, trigger, item.insert));

  /** Arrow keys, Enter/Tab (pick) and Escape (close, the text stays as typed) while the list is open. */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || !completion) return false;
    const n = items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (e.key === "ArrowDown" ? (s + 1) % n : (s - 1 + n) % n));
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
      e.preventDefault();
      pick(completion.trigger, items[selected] ?? items[0]!);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissedAt(completion.trigger.start);
      return true;
    }
    return false;
  };

  return { open, completion: open ? completion : null, items, selected, setSelected, pick, onKeyDown };
}
