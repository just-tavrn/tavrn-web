// SPDX-License-Identifier: Apache-2.0
/**
 * Development builds only: named counters the UI tests read from `window.__tavrnCounts` (renders of the voice stage,
 * whiteboard diffs, received cursor events), so a performance property can be pinned in a spec. A no-op in
 * production builds.
 */
export function devCount(name: string): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const w = window as { __tavrnCounts?: Record<string, number> };
  const counts = (w.__tavrnCounts ??= {});
  counts[name] = (counts[name] ?? 0) + 1;
}
