// SPDX-License-Identifier: Apache-2.0
/**
 * Updates (docs/DESKTOP.md "The Linux shell (Electron)", "Updates"): electron-updater against the GitHub releases of
 * tavrn-web. electron-builder writes the feed's settings into the package (`resources/app-update.yml`, from the
 * `publish` entry of electron-builder.config.mjs) and the release carries `latest-linux.yml` with the SHA-512 of the
 * `.AppImage` and `.deb`. A development run and a package without the feed offer no updates (`updater: false` in
 * `appInfo`). While the repository is private the check fails (GitHub answers 404) and the client stays quiet, as with
 * the Tauri updater. The AppImage replaces itself; the `.deb` is installed with the system's package tools (an
 * administrator password is asked).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { check, type IpcRegistry } from "./ipc.ts";

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** The feed's settings that electron-builder writes into a package with a `publish` entry. */
export function updaterConfigured(packaged: boolean, resourcesPath: string): boolean {
  return packaged && existsSync(join(resourcesPath, "app-update.yml"));
}

/** Release notes as plain text (the GitHub feed answers HTML, several releases as a list). */
export function notesText(notes: unknown): string | null {
  const text = typeof notes === "string" ? notes : Array.isArray(notes) ? notes.map((n) => (typeof n?.note === "string" ? n.note : "")).join("\n\n") : "";
  const plain = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain ? plain.slice(0, 10_000) : null;
}

interface AutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string; releaseNotes?: unknown } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** electron-updater, loaded on first use (it needs Electron at import time). */
async function autoUpdater(): Promise<AutoUpdater> {
  const mod = (await import("electron-updater")) as unknown as { autoUpdater?: AutoUpdater; default?: { autoUpdater: AutoUpdater } };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) throw new Error("update.unavailable");
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  return updater;
}

/** The `updater` namespace of the bridge (the Tauri shell's `check_update` and `install_update`). */
export function registerUpdaterHandlers(registry: IpcRegistry, configured: boolean, load: () => Promise<AutoUpdater> = autoUpdater): void {
  const newer = async () => {
    if (!configured) throw "update.not_configured";
    const updater = await load();
    const found = await updater.checkForUpdates();
    return { updater, found: found?.isUpdateAvailable ? found.updateInfo : null };
  };
  registry.handle("updater", "checkUpdate", check.args([]), async (): Promise<UpdateInfo | null> => {
    const { found } = await newer();
    return found ? { version: found.version, notes: notesText(found.releaseNotes) } : null;
  });
  registry.handle("updater", "installUpdate", check.args([]), async () => {
    const { updater, found } = await newer();
    if (!found) throw "update.none";
    await updater.downloadUpdate();
    updater.quitAndInstall(false, true);
  });
}
