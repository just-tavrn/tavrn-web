// SPDX-License-Identifier: Apache-2.0
/**
 * Start-up hardening of the Electron shell (docs/DESKTOP.md "The Linux shell (Electron)"):
 *
 * - **No spellchecker** in any session: Chromium would otherwise download its dictionaries from Google's servers at the
 *   first start, before any node is chosen, and the app promises to talk only to the chosen nodes and GitHub
 *   (apps/desktop/TERMS.md). Text fields are not spell-checked (the main window sets `spellcheck: false` anyway).
 * - **No remote debugging in a package**: `--remote-debugging-port`/`--remote-debugging-pipe` would open the app's pages
 *   (and so the bridge with the keychain) to the DevTools protocol. A package refuses to start with them unless
 *   `TAVRN_DESKTOP_ALLOW_DEBUGGING=1` is set, which only the packaged Playwright specs do (launch.ts).
 */

/** The part of an Electron session this module uses. */
export interface SpellSession {
  setSpellCheckerEnabled(enable: boolean): void;
}

/** Switches the spellchecker (and with it every dictionary download) off in each session. */
export function disableSpellChecker(sessions: readonly SpellSession[]): void {
  for (const ses of sessions) ses.setSpellCheckerEnabled(false);
}

/** The environment variable that lets a package start with remote debugging (the packaged Playwright specs). */
export const ALLOW_DEBUGGING_ENV = "TAVRN_DESKTOP_ALLOW_DEBUGGING";
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"];

/** The debugging switch a package must refuse, or null (development builds may always be debugged). */
export function refusedDebugSwitch(packaged: boolean, hasSwitch: (name: string) => boolean, env: NodeJS.ProcessEnv): string | null {
  if (!packaged || env[ALLOW_DEBUGGING_ENV] === "1") return null;
  return DEBUG_SWITCHES.find((s) => hasSwitch(s)) ?? null;
}
