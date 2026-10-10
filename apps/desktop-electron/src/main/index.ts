// SPDX-License-Identifier: Apache-2.0
/**
 * tavrn desktop app for Linux: an Electron shell around the bundled web client (docs/DESKTOP.md "The Linux shell
 * (Electron)"). The main window shows only the bundled client (`app://tavrn`, `protocol.ts`); the client talks to the
 * home node chosen in its node picker over https/wss and reaches the shell only through the preload's bridge
 * (`window.tavrnShell`), whose calls the IPC registry checks (`ipc.ts`). One instance per user: a second start shows
 * the running app.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, session, shell, Tray } from "electron";
import { DIR_NAME, Settings, settingsPath } from "./config.ts";
import { Downloads, handleWillDownload, registerFilesHandlers, saveDialogOptions, TEST_SAVE_DIR_ENV } from "./downloads.ts";
import { ShellEvents } from "./events.ts";
import { devServerUrl, isAppPage, permission } from "./guard.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import { BACKEND_ENV, Keychain, passwordStoreSwitch, registerKeychainHandlers, safeStorageCipher } from "./keychain.ts";
import { Notifier, registerNotifyHandlers } from "./notify.ts";
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, installAppProtocol } from "./protocol.ts";
import { registerShellHandlers } from "./shell.ts";
import { attachWindow, electronTrayHost, registerTrayHandlers, TrayController } from "./tray.ts";
import { decodePng } from "./tray_icon.ts";
import { createMainWindow, showMain } from "./windows.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The version of the app: the packaged one carries web/package.json's; a development run reads it there. */
function appVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    return (JSON.parse(readFileSync(resolve(app.getAppPath(), "../../web/package.json"), "utf8")) as { version: string }).version;
  } catch {
    return app.getVersion();
  }
}

function main(): void {
  // Before the app is ready: the scheme of the bundled client, the name and the profile directory (which also holds the
  // settings file and the single-instance lock).
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
  app.setName("tavrn");
  app.setPath("userData", join(app.getPath("appData"), DIR_NAME));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // The keychain's safeStorage asks the desktop's Secret Service, also on desktops Chromium does not know (keychain.ts).
  const passwordStore = passwordStoreSwitch(process.env, app.commandLine.hasSwitch("password-store"));
  if (passwordStore) app.commandLine.appendSwitch("password-store", passwordStore);
  const devUrl = devServerUrl(app.isPackaged, process.env.TAVRN_DESKTOP_DEV_URL);
  const webRoot = app.isPackaged ? join(app.getAppPath(), "web") : resolve(app.getAppPath(), "../../web/dist");
  const icon = app.isPackaged ? join(app.getAppPath(), "icons", "icon.png") : resolve(app.getAppPath(), "../desktop/src-tauri/icons/icon.png");
  // The base of the tray icons (tray_icon.ts draws the badges on it).
  const trayLogo = app.isPackaged ? join(app.getAppPath(), "icons", "128x128@2x.png") : resolve(app.getAppPath(), "../desktop/src-tauri/icons/128x128@2x.png");
  const settings = new Settings(settingsPath(app.getPath("appData")));
  let mainWindow: BrowserWindow | null = null;

  const openExternal = (url: string) => shell.openExternal(url);
  // Only the main window's top frame showing the bundled client may call the bridge.
  const trusted = (event: IpcEventLike) =>
    !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && isAppPage(event.senderFrame.url, devUrl);
  const registry = new IpcRegistry(trusted);
  registerShellHandlers(registry, { settings, version: appVersion(), openExternal });
  // The keychain is chosen once the app is ready (safeStorage knows its keyring only then); no call comes earlier.
  let keychain: Keychain | null = null;
  const keychainNow = () =>
    app.isReady() ? (keychain ??= Keychain.forSetting(process.env[BACKEND_ENV], { dir: app.getPath("userData"), cipher: safeStorageCipher(safeStorage) })) : Keychain.unavailable();
  registerKeychainHandlers(registry, { settings, keychain: keychainNow });
  // Notifications and the tray; their clicks come back to the client as shell events.
  const events = new ShellEvents(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null));
  const show = () => showMain(mainWindow);
  let quitting = false;
  app.on("before-quit", () => {
    quitting = true;
    downloads.abortAll();
  });
  const quit = () => app.quit();
  registerNotifyHandlers(registry, { notifier: new Notifier({ create: (o) => new Notification(o), supported: () => Notification.isSupported(), showMain: show, events, icon }) });
  const tray = new TrayController({
    createHost: (onMenu, onClick) => electronTrayHost({ Tray, Menu, nativeImage }, decodePng(readFileSync(trayLogo)), onMenu, onClick),
    settings,
    events,
    windowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
    showMain: show,
    hideMain: () => mainWindow?.hide(),
    quit,
  });
  registerTrayHandlers(registry, { tray, settings, quit });
  // Downloads through the save dialog (the test hook's directory instead when set).
  const downloads = new Downloads({
    testDir: process.env[TEST_SAVE_DIR_ENV] || null,
    downloadsDir: () => {
      try {
        return app.getPath("downloads");
      } catch {
        return app.getPath("home");
      }
    },
    chooseTarget: async (name, dir) => {
      const options = saveDialogOptions(name, dir);
      const chosen = mainWindow && !mainWindow.isDestroyed() ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
    },
    reveal: (path) => shell.showItemInFolder(path),
  });
  registerFilesHandlers(registry, { downloads });
  registry.install(ipcMain);

  app.on("second-instance", () => showMain(mainWindow));
  // No other web contents ever opens windows or embeds a webview.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(() => {
    if (!devUrl && !existsSync(join(webRoot, "index.html"))) {
      console.error(`tavrn: the bundled client is missing (${webRoot}); build it with \`pnpm --filter @tavrn/web build\``);
      app.exit(1);
      return;
    }
    Menu.setApplicationMenu(null);
    const ses = session.defaultSession;
    installAppProtocol(ses.protocol, webRoot);
    const fromMain = (contents: Electron.WebContents | null) => !!mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents;
    ses.setPermissionRequestHandler((contents, name, callback, details) => callback(permission(name, details.requestingUrl, fromMain(contents), devUrl)));
    ses.setPermissionCheckHandler((contents, name, origin, details) => permission(name, details.requestingUrl ?? origin, fromMain(contents), devUrl));
    ses.setDevicePermissionHandler(() => false);
    ses.on("will-download", (_event, item, contents) => handleWillDownload(item, fromMain(contents), downloads));
    tray.create();
    mainWindow = createMainWindow({ preload: join(here, "../preload/index.cjs"), icon, devUrl, openExternal: (url) => void openExternal(url) });
    attachWindow(mainWindow, tray, () => quitting);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });
}

main();
