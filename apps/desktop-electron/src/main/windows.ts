// SPDX-License-Identifier: Apache-2.0
/**
 * The main window: the bundled client from `app://tavrn` (in development the Vite dev server), sandboxed, with the
 * preload's bridge as its only way into the shell. Its navigations and new windows go through `guard.ts`: the client's
 * own pages load, web links open in the system browser, everything else is refused.
 */
import { BrowserWindow } from "electron";
import { APP_ORIGIN } from "./protocol.ts";
import { navigation, newWindow } from "./guard.ts";

export interface MainWindowOptions {
  /** The bundled preload (`dist/preload/index.cjs`). */
  preload: string;
  /** The window icon (Linux). */
  icon: string;
  /** The Vite dev server in development, otherwise null. */
  devUrl: string | null;
  /** Opens a link in the system browser (already validated). */
  openExternal: (url: string) => void;
}

/** The size of the Tauri shell's window (tauri.conf.json). */
const SIZE = { width: 1280, height: 800, minWidth: 360, minHeight: 560 };

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...SIZE,
    title: "tavrn",
    icon: options.icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: options.devUrl !== null,
    },
  });
  const contents = win.webContents;
  // Every navigation of the window and its frames (the embeds) is checked; refused web links open in the browser.
  contents.on("will-frame-navigate", (event) => {
    const decision = navigation(event.url, options.devUrl);
    if (decision.kind === "allow") return;
    event.preventDefault();
    if (decision.kind === "external" && event.isMainFrame) options.openExternal(decision.url);
  });
  contents.on("will-redirect", (event) => {
    if (navigation(event.url, options.devUrl).kind !== "allow") event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const link = newWindow(url, options.devUrl);
    if (link) options.openExternal(link);
    return { action: "deny" };
  });
  // The page names the window ("tavrn" in every language); a document title never replaces it.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());
  void win.loadURL(options.devUrl ?? `${APP_ORIGIN}/`);
  return win;
}

/** Brings the main window to the front (a second start of the app; later the tray and notification clicks). */
export function showMain(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
