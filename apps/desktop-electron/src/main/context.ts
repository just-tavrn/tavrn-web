// SPDX-License-Identifier: Apache-2.0
/**
 * What every part of the shell gets when `index.ts` starts it: the IPC registry to register its handlers with, the
 * events to the client, the settings, the main window and the app's paths. A part is a function of this context
 * (`registerShellHandlers` and its siblings); `index.ts` keeps the list.
 */
import type { BrowserWindow } from "electron";
import type { Settings } from "./config.ts";
import type { ShellEvents } from "./events.ts";
import type { IpcRegistry } from "./ipc.ts";

export interface ShellContext {
  registry: IpcRegistry;
  events: ShellEvents;
  settings: Settings;
  /** The main window, when it exists. */
  mainWindow: () => BrowserWindow | null;
  /** Brings the main window to the front (tray, notification clicks, a second start). */
  showMain: () => void;
  /** The Vite dev server in a development run, otherwise null. */
  devUrl: string | null;
  /** The window icon (Linux). */
  icon: string;
  /** Opens a validated web link in the system browser. */
  openExternal: (url: string) => Promise<void>;
}

/** A part of the shell: registers its handlers (and whatever else it needs) once the app is starting. */
export type ShellPart = (context: ShellContext) => void;
