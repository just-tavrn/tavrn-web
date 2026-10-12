// SPDX-License-Identifier: Apache-2.0
/**
 * The passkey dialog's window (docs/DESKTOP.md "Passkeys on Linux"): a small modal window over the main window, opened
 * when a ceremony starts, showing what the user has to do (`passkey_dialog.ts`) and taking the PIN, the chosen passkey
 * or a cancel back. Its page runs no script; its preload talks to this module only (its own window, checked by sender).
 * Closing the window or Escape cancels the ceremony; once the ceremony is over the window closes by itself, unless it
 * shows why the key refused (then the user closes it).
 */
import { BrowserWindow, ipcMain } from "electron";
import { dialogAnswer, dialogContent, dialogLabels, dialogUrl, type DialogContent, type DialogView } from "./passkey_dialog.ts";
import type { Ceremony, PasskeyPrompt } from "./passkeys.ts";

const DIALOG_CONTENT = "tavrn-passkey:content";
const DIALOG_STATE = "tavrn-passkey:state";
const DIALOG_ANSWER = "tavrn-passkey:answer";

export interface PasskeyWindowOptions {
  /** The main window, when it exists (the dialog's parent). */
  mainWindow: () => BrowserWindow | null;
  /** The bundled dialog preload (`dist/preload/passkey.cjs`). */
  preload: string;
  /** The app's locale (`app.getLocale()`). */
  locale: () => string;
}

interface Open {
  win: BrowserWindow;
  ceremony: Ceremony;
  rp: string;
  content: DialogContent;
  answer: (a: ReturnType<typeof dialogAnswer>) => void;
  /** The ceremony is over (closing the window cancels nothing). */
  ended: boolean;
}

/** The dialog of the app's ceremonies (one at a time, as the ceremonies). */
export function passkeyWindow(options: PasskeyWindowOptions): PasskeyPrompt {
  let open: Open | null = null;
  const fromDialog = (sender: unknown) => !!open && !open.win.isDestroyed() && sender === open.win.webContents;
  ipcMain.handle(DIALOG_CONTENT, (event) => {
    if (!fromDialog(event.sender)) throw new Error("passkey.forbidden");
    return open?.content;
  });
  ipcMain.on(DIALOG_ANSWER, (event, raw: unknown) => {
    if (!open || !fromDialog(event.sender)) return;
    // After a problem the only button closes the dialog (which cancels a ceremony still waiting).
    if (open.content.final) {
      open.win.close();
      return;
    }
    open.answer(dialogAnswer(raw, open.content.accounts.length));
  });

  const render = (view: DialogView) => {
    if (!open) return;
    open.content = dialogContent(view, dialogLabels(options.locale()), open.ceremony, open.rp);
    if (!open.win.isDestroyed()) open.win.webContents.send(DIALOG_STATE, open.content);
  };

  return {
    open(ceremony, rp, answer) {
      if (open && !open.win.isDestroyed()) open.win.destroy();
      const parent = options.mainWindow();
      const content = dialogContent({ view: "waiting" }, dialogLabels(options.locale()), ceremony, rp);
      const win = new BrowserWindow({
        ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
        width: 440,
        height: 340,
        minWidth: 320,
        minHeight: 260,
        title: content.title,
        show: false,
        autoHideMenuBar: true,
        webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false, navigateOnDragDrop: false },
      });
      const mine: Open = { win, ceremony, rp, content, answer, ended: false };
      open = mine;
      win.webContents.on("will-frame-navigate", (e) => e.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.on("closed", () => {
        if (open !== mine) return;
        open = null;
        // Closed by the user while the key still waits: the ceremony ends as cancelled.
        if (!mine.ended) answer({ type: "cancel" });
      });
      win.once("ready-to-show", () => win.show());
      void win.loadURL(dialogUrl(options.locale()));
    },
    show(view) {
      // After a problem nothing replaces its message.
      if (!open || open.ended || open.content.final) return;
      render(view);
    },
    done() {
      if (!open) return;
      open.ended = true;
      // A problem stays on screen until the user closes it; everything else is over with the ceremony.
      if (!open.content.final && !open.win.isDestroyed()) open.win.close();
    },
  };
}
