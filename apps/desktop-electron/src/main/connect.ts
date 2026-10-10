// SPDX-License-Identifier: Apache-2.0
/**
 * The sign-in window (docs/DESKTOP.md "Signing in"): the chosen node's own `/connect?session=…` page of an app session,
 * opened by `openConnect` after `guard.connectUrl` checked origin, path and parameters, and closed by `closeConnect`.
 * It follows https pages from there (identity providers redirect; plain http only on this computer), never the bundled
 * client or `app:`, `file:`, `data:`, `javascript:`, `blob:` URLs; new windows go to the system browser. It has no
 * preload and no IPC: the node's web client in it runs as a plain web client. Its session (`persist:tavrn-connect`,
 * persistent like the Tauri window's storage, apart from the app's) denies every permission and download and adds
 * `TavrnDesktopSignIn/1` to the user agent, by which the page knows it is in the sign-in window (it signs its own
 * session out after the handoff).
 */
import { BrowserWindow, session, type Session } from "electron";
import { connectNavigation, newWindow } from "./guard.ts";

export const CONNECT_PARTITION = "persist:tavrn-connect";
/** The user agent marker of the sign-in window (`web/src/platform/tauriDetect.ts` `inSignInWindow`). */
export const SIGN_IN_MARKER = "TavrnDesktopSignIn/1";

export interface ConnectOptions {
  devUrl: string | null;
  icon: string;
  openExternal: (url: string) => void;
}

let configured: Session | null = null;

function connectSession(): Session {
  if (configured) return configured;
  const ses = session.fromPartition(CONNECT_PARTITION);
  const ua = ses.getUserAgent();
  if (!ua.includes(SIGN_IN_MARKER)) ses.setUserAgent(`${ua} ${SIGN_IN_MARKER}`);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  ses.on("will-download", (event) => event.preventDefault());
  configured = ses;
  return ses;
}

export class ConnectWindow {
  readonly #options: ConnectOptions;
  #win: BrowserWindow | null = null;

  constructor(options: ConnectOptions) {
    this.#options = options;
  }

  /** Shows `url` (already validated by `connectUrl`), creating the window on first use. */
  async open(url: string): Promise<void> {
    const existing = this.#win;
    if (existing && !existing.isDestroyed()) {
      void existing.loadURL(url).catch(() => undefined);
      existing.show();
      existing.focus();
      return;
    }
    const { devUrl, openExternal } = this.#options;
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      minWidth: 360,
      minHeight: 480,
      title: "tavrn",
      icon: this.#options.icon,
      autoHideMenuBar: true,
      webPreferences: {
        session: connectSession(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        devTools: devUrl !== null,
      },
    });
    this.#win = win;
    win.on("closed", () => {
      if (this.#win === win) this.#win = null;
    });
    const contents = win.webContents;
    contents.on("will-frame-navigate", (event) => {
      const decision = connectNavigation(event.url, devUrl);
      if (decision.kind === "allow") return;
      event.preventDefault();
      if (decision.kind === "external" && event.isMainFrame) openExternal(decision.url);
    });
    contents.on("will-redirect", (event) => {
      if (connectNavigation(event.url, devUrl).kind !== "allow") event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url: target }) => {
      const link = newWindow(target);
      if (link) openExternal(link);
      return { action: "deny" };
    });
    win.on("page-title-updated", (event) => event.preventDefault());
    // A page that fails to load shows Chromium's error page; the app keeps waiting ("Open the page again").
    void win.loadURL(url).catch(() => undefined);
  }

  close(): void {
    if (this.#win && !this.#win.isDestroyed()) this.#win.close();
    this.#win = null;
  }
}
