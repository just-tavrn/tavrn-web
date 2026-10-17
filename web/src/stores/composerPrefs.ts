// SPDX-License-Identifier: Apache-2.0
/**
 * Device-local preferences of the composer (docs/CLIENT.md "The composer"): whether the formatting bar is shown and
 * whether the input shows Markdown styled while typing. Preferences only, never message content (unsent text lives
 * in `composer/drafts.ts`, memory only).
 */
import { create } from "zustand";

export interface ComposerPrefs {
  formatBar: boolean;
  styledInput: boolean;
}

export const DEFAULT_COMPOSER_PREFS: ComposerPrefs = { formatBar: false, styledInput: false };

export const COMPOSER_PREFS_KEY = "tavrn.composer";

export function parseComposerPrefs(raw: unknown): ComposerPrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    formatBar: typeof r.formatBar === "boolean" ? r.formatBar : DEFAULT_COMPOSER_PREFS.formatBar,
    styledInput: typeof r.styledInput === "boolean" ? r.styledInput : DEFAULT_COMPOSER_PREFS.styledInput,
  };
}

function readLocal(): ComposerPrefs {
  try {
    const raw = localStorage.getItem(COMPOSER_PREFS_KEY);
    return parseComposerPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_COMPOSER_PREFS;
  }
}

interface State extends ComposerPrefs {
  set: (patch: Partial<ComposerPrefs>) => void;
  /** Reads the stored preferences again (tests, another tab). */
  reload: () => void;
}

export const useComposerPrefs = create<State>((set, get) => ({
  ...readLocal(),
  set: (patch) => {
    const next = parseComposerPrefs({ formatBar: get().formatBar, styledInput: get().styledInput, ...patch });
    try {
      localStorage.setItem(COMPOSER_PREFS_KEY, JSON.stringify(next));
    } catch {
      /* storage disabled: memory only */
    }
    set(next);
  },
  reload: () => set(readLocal()),
}));
