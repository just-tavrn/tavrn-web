// SPDX-License-Identifier: Apache-2.0
/**
 * Start-up hardening of the Electron shell (docs/DESKTOP.md "The Linux shell (Electron)"):
 *
 * - **No spellchecker** in any session: Chromium would otherwise download its dictionaries from Google's servers at the
 *   first start, before any node is chosen, and the app promises to talk only to the chosen nodes and GitHub
 *   (apps/desktop/TERMS.md). Chromium starts the spellchecker when it creates a profile, before the app is ready, so
 *   the profiles' `Preferences` files are seeded with the spellchecker off and no dictionaries before that
 *   ({@link seedNoSpellcheck}); once ready, both sessions switch it off again ({@link disableSpellChecker}). Text fields
 *   are not spell-checked (the main window sets `spellcheck: false` anyway).
 * - **No remote debugging in a package**: `--remote-debugging-port`/`--remote-debugging-pipe` would open the app's pages
 *   (and so the bridge with the keychain) to the DevTools protocol. A package refuses to start with them unless
 *   `TAVRN_DESKTOP_ALLOW_DEBUGGING=1` is set, which only the packaged Playwright specs do (launch.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes `spellcheck.enabled = false` and `spellcheck.dictionaries = []` into the Chromium `Preferences` file of each
 * profile directory (created when missing), before Chromium reads it. A file that is not a JSON object is left alone.
 */
export function seedNoSpellcheck(profileDirs: readonly string[]): void {
  for (const dir of profileDirs) {
    const file = join(dir, "Preferences");
    let prefs: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        prefs = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    const current = typeof prefs.spellcheck === "object" && prefs.spellcheck !== null ? (prefs.spellcheck as Record<string, unknown>) : {};
    if (current.enabled === false && Array.isArray(current.dictionaries) && current.dictionaries.length === 0) continue;
    prefs.spellcheck = { ...current, enabled: false, dictionaries: [], dictionary: "" };
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tavrn-tmp`;
    writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** The part of an Electron session this module uses. */
export interface SpellSession {
  setSpellCheckerEnabled(enable: boolean): void;
  setSpellCheckerLanguages(languages: string[]): void;
}

/** Switches the spellchecker off and drops its languages (and with them every dictionary download) in each session. */
export function disableSpellChecker(sessions: readonly SpellSession[]): void {
  for (const ses of sessions) {
    ses.setSpellCheckerEnabled(false);
    try {
      ses.setSpellCheckerLanguages([]);
    } catch {
      // macOS uses the system's spellchecker and has no languages to set
    }
  }
}

/** The environment variable that lets a package start with remote debugging (the packaged Playwright specs). */
export const ALLOW_DEBUGGING_ENV = "TAVRN_DESKTOP_ALLOW_DEBUGGING";
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"];

/** The debugging switch a package must refuse, or null (development builds may always be debugged). */
export function refusedDebugSwitch(packaged: boolean, hasSwitch: (name: string) => boolean, env: NodeJS.ProcessEnv): string | null {
  if (!packaged || env[ALLOW_DEBUGGING_ENV] === "1") return null;
  return DEBUG_SWITCHES.find((s) => hasSwitch(s)) ?? null;
}
