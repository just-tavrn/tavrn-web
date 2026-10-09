// SPDX-License-Identifier: Apache-2.0
import { isTauri } from "@tauri-apps/api/core";

/** Label of the app's window (`apps/desktop/src-tauri/src/lib.rs`): the only one that shows the bundled client. */
const MAIN_WINDOW = "main";

/**
 * True inside the desktop app: the Tauri runtime announces itself (never decided by the user agent). Only the main
 * window runs the app; the sign-in window shows the node's own web client, which must behave like in a browser.
 */
export function detectTauri(): boolean {
  if (!isTauri()) return false;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  return label === undefined || label === MAIN_WINDOW;
}

/** Label of the sign-in window (`CONNECT_WINDOW` in `apps/desktop/src-tauri/src/lib.rs`). */
const SIGN_IN_WINDOW = "connect";

/**
 * True for the node's page in the desktop app's sign-in window (not in a browser tab): it signs itself out after a
 * handoff (docs/DESKTOP.md "Signing in").
 */
export function inSignInWindow(): boolean {
  if (!isTauri()) return false;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return internals?.metadata?.currentWindow?.label === SIGN_IN_WINDOW;
}
