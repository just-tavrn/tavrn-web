// SPDX-License-Identifier: Apache-2.0
/**
 * Screen sharing (`getDisplayMedia`) of the main window through the shell's own picker (docs/DESKTOP.md "The Linux
 * shell (Electron)"): Chromium asks `setDisplayMediaRequestHandler`, the shell lists the screens and windows
 * (`desktopCapturer`, X11) in a small modal window (`picker.ts`) and hands the chosen source back; Escape, Cancel or
 * closing the window refuses (Electron rejects the page's request with `AbortError`, which the client takes as "the
 * user closed the picker"). With nothing to share the picker says so. Only the main window's own page may ask. On Wayland
 * `desktopCapturer` goes through the desktop portal (PipeWire): the portal's own dialog picks, and the shell takes its
 * one source without a second picker. The sound follows the page's request as `captureAudio` of `picker.ts` says
 * (the system's sound on Windows only).
 */
import { BrowserWindow, desktopCapturer, ipcMain, type Session } from "electron";
import { captureAudio, pickerChoice, pickerLabels, pickerSources, pickerUrl, type PickerData, type PickerSource } from "./picker.ts";

const PICKER_SOURCES = "tavrn-picker:sources";
const PICKER_CHOOSE = "tavrn-picker:choose";

export interface CaptureOptions {
  /** The main window, when it exists. */
  mainWindow: () => BrowserWindow | null;
  /** Whether an origin is the bundled client's (`guard.isAppPage`). */
  isApp: (origin: string) => boolean;
  /** The bundled picker preload (`dist/preload/picker.cjs`). */
  preload: string;
  /** The app's locale (`app.getLocale()`). */
  locale: () => string;
}

/** The desktop session is Wayland (the portal picks the source). */
function wayland(): boolean {
  return process.env.XDG_SESSION_TYPE === "wayland" && !!process.env.WAYLAND_DISPLAY;
}

/**
 * The screens, then the windows. X11's screen capturer can fail on its first use right after the start (no pixel buffer
 * yet), so an empty list of screens is asked once more.
 */
async function desktopSources(): Promise<Electron.DesktopCapturerSource[]> {
  const ask = (type: "screen" | "window") => desktopCapturer.getSources({ types: [type], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false }).catch(() => []);
  let screens = await ask("screen");
  if (!screens.length) screens = await ask("screen");
  return [...screens, ...(await ask("window"))];
}

let open: { win: BrowserWindow; data: PickerData; done: (id: string | null) => void } | null = null;

/** Shows the picker over `parent`; resolves the chosen source's id or null. One picker at a time. */
function pick(parent: BrowserWindow, data: PickerData, options: CaptureOptions): Promise<string | null> {
  if (open) return Promise.resolve(null);
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 720,
      height: 520,
      minWidth: 360,
      minHeight: 320,
      title: data.labels.title,
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false, navigateOnDragDrop: false },
    });
    const finish = (id: string | null) => {
      if (!open || open.win !== win) return;
      open = null;
      resolve(pickerChoice(id, data.sources));
      if (!win.isDestroyed()) win.close();
    };
    open = { win, data, done: finish };
    win.webContents.on("will-frame-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => finish(null));
    win.once("ready-to-show", () => win.show());
    void win.loadURL(pickerUrl(options.locale()));
  });
}

/** Answers the picker's preload (its own window only). */
function installPickerIpc(): void {
  ipcMain.handle(PICKER_SOURCES, (event) => {
    if (!open || event.sender !== open.win.webContents) throw new Error("picker.forbidden");
    return open.data;
  });
  ipcMain.on(PICKER_CHOOSE, (event, id: unknown) => {
    if (open && event.sender === open.win.webContents) open.done(typeof id === "string" ? id : null);
  });
}

/** Installs the handler of `getDisplayMedia` on the main window's session. */
export function installDisplayMediaHandler(ses: Session, options: CaptureOptions): void {
  installPickerIpc();
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const main = options.mainWindow();
      if (!main || main.isDestroyed() || request.frame !== main.webContents.mainFrame || !options.isApp(request.securityOrigin) || !request.videoRequested) {
        callback(null);
        return;
      }
      void (async () => {
        try {
          const found = await desktopSources();
          // The app's own windows are not offered (sharing the call into itself).
          const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
          const listed = found.filter((s) => !own.has(s.id));
          const offered: PickerSource[] = pickerSources(listed.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL() })));
          let id: string | null;
          if (wayland() && offered.length <= 1) id = offered[0]?.id ?? null;
          else id = await pick(main, { labels: pickerLabels(options.locale()), sources: offered }, options);
          const source = id ? listed.find((s) => s.id === id) : undefined;
          const audio = captureAudio(process.platform, request.audioRequested);
          callback(source ? { video: source, ...(audio ? { audio } : {}) } : null);
        } catch (e) {
          console.error("tavrn: screen sharing failed", e);
          callback(null);
        }
      })();
    },
    { useSystemPicker: false },
  );
}
