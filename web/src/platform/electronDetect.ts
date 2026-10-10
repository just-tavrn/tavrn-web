// SPDX-License-Identifier: Apache-2.0
/**
 * The Electron shell (the Linux desktop app, `apps/desktop-electron`): its preload exposes `window.tavrnShell` in the
 * main window only (docs/DESKTOP.md "The Linux shell (Electron)"). The sign-in window has no preload, so the node's page
 * there runs as a plain web client. Never decided by the user agent.
 */
import type { TavrnShellBridge } from "./electronBridge";

/** The bridge of the Electron shell's main window, or null anywhere else. */
export function electronBridge(): TavrnShellBridge | null {
  const bridge = (window as unknown as { tavrnShell?: Partial<TavrnShellBridge> }).tavrnShell;
  return bridge?.kind === "electron" && bridge.window === "main" ? (bridge as TavrnShellBridge) : null;
}

/** True inside the Electron shell's main window. */
export function detectElectron(): boolean {
  return electronBridge() !== null;
}

/**
 * The user agent marker of the Electron shell's sign-in window (`SIGN_IN_MARKER`, `apps/desktop-electron/src/main/
 * connect.ts`): the window has no preload, so the node's page there knows it only by this.
 */
const SIGN_IN_MARKER = /(^|\s)TavrnDesktopSignIn\/1(\s|$)/;

/** True for the node's page in the Electron shell's sign-in window (not in a browser tab). */
export function inElectronSignInWindow(): boolean {
  return typeof navigator !== "undefined" && SIGN_IN_MARKER.test(navigator.userAgent);
}
