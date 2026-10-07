// SPDX-License-Identifier: Apache-2.0
/**
 * Device-local accessibility settings (design note 4.14 item 4, docs/ACCESSIBILITY.md). `announceMessages`: screen
 * readers announce new messages of others in the open conversation (a polite live region); some people prefer
 * to read the feed themselves and turn it off.
 */
import { create } from "zustand";

export interface AccessibilitySettings {
  announceMessages: boolean;
}

export const DEFAULT_ACCESSIBILITY: AccessibilitySettings = { announceMessages: true };

const KEY = "tavrn.accessibility";

export function parseAccessibility(raw: unknown): AccessibilitySettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { announceMessages: typeof r.announceMessages === "boolean" ? r.announceMessages : DEFAULT_ACCESSIBILITY.announceMessages };
}

function readLocal(): AccessibilitySettings {
  try {
    const raw = localStorage.getItem(KEY);
    return parseAccessibility(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_ACCESSIBILITY;
  }
}

interface State extends AccessibilitySettings {
  set: (patch: Partial<AccessibilitySettings>) => void;
}

export const useAccessibility = create<State>((set, get) => ({
  ...readLocal(),
  set: (patch) => {
    const next = parseAccessibility({ announceMessages: get().announceMessages, ...patch });
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage disabled: memory only */
    }
    set(next);
  },
}));
