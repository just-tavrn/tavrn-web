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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, session, shell, Tray } from "electron";
import { installDisplayMediaHandler } from "./capture.ts";
import { DIR_NAME, Settings, importTauriSettings, settingsPath, tauriSettingsPath } from "./config.ts";
import { CONNECT_PARTITION, ConnectWindow } from "./connect.ts";
import type { ShellContext, ShellPart } from "./context.ts";
import { Downloads, handleWillDownload, registerFilesHandlers, saveDialogOptions, TEST_SAVE_DIR_ENV } from "./downloads.ts";
import { ShellEvents } from "./events.ts";
import { devServerUrl, isAppPage, permission } from "./guard.ts";
import { disableSpellChecker, refusedDebugSwitch, seedNoSpellcheck } from "./hardening.ts";
import { Hotkeys, nativeKeyListener, registerHotkeyHandlers } from "./hotkeys.ts";
import { IpcRegistry, fromMainPage, type IpcEventLike } from "./ipc.ts";
import { BACKEND_ENV, Keychain, passwordStoreSwitch, registerKeychainHandlers, safeStorageCipher } from "./keychain.ts";
import { Notifier, registerNotifyHandlers } from "./notify.ts";
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, installAppProtocol } from "./protocol.ts";
import { HttpFetcher, resolveNode, systemSrv } from "./resolve.ts";
import { registerShellHandlers } from "./shell.ts";
import { attachWindow, electronTrayHost, registerTrayHandlers, TrayController } from "./tray.ts";
import { decodePng } from "./tray_icon.ts";
import { channelSetting, registerUpdaterHandlers, updaterSetup } from "./updater.ts";
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
  // A package never opens its pages to the DevTools protocol (hardening.ts).
  const debugSwitch = refusedDebugSwitch(app.isPackaged, (name) => app.commandLine.hasSwitch(name), process.env);
  if (debugSwitch) {
    console.error(`tavrn: --${debugSwitch} is not supported by the packaged app`);
    app.exit(1);
    return;
  }
  // Before the app is ready: the scheme of the bundled client, the name and the profile directory (which also holds the
  // settings file and the single-instance lock).
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
  app.setName("tavrn");
  // Windows (the fallback build): the app id of its installer's start menu entry (electron-builder.config.mjs `win.appId`),
  // which Windows needs for the app's notifications and taskbar entry.
  if (process.platform === "win32") app.setAppUserModelId("org.tavrn.desktop.electron");
  app.setPath("userData", join(app.getPath("appData"), DIR_NAME));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Chromium starts the spellchecker when it creates the profiles (before ready): they start with it off (hardening.ts).
  seedNoSpellcheck([app.getPath("userData"), join(app.getPath("userData"), "Partitions", CONNECT_PARTITION.slice("persist:".length))]);
  // The keychain's safeStorage asks the desktop's Secret Service, also on desktops Chromium does not know (keychain.ts).
  const passwordStore = passwordStoreSwitch(process.env, app.commandLine.hasSwitch("password-store"));
  if (passwordStore) app.commandLine.appendSwitch("password-store", passwordStore);
  const devUrl = devServerUrl(app.isPackaged, process.env.TAVRN_DESKTOP_DEV_URL);
  const webRoot = app.isPackaged ? join(app.getAppPath(), "web") : resolve(app.getAppPath(), "../../web/dist");
  const icon = app.isPackaged ? join(app.getAppPath(), "icons", "icon.png") : resolve(app.getAppPath(), "../desktop/src-tauri/icons/icon.png");
  // The base of the tray icons (tray_icon.ts draws the badges on it).
  const trayLogo = app.isPackaged ? join(app.getAppPath(), "icons", "128x128@2x.png") : resolve(app.getAppPath(), "../desktop/src-tauri/icons/128x128@2x.png");
  const configDir = app.getPath("appData");
  // Switching shells: the Tauri app's home node is taken over once, before the settings are read.
  importTauriSettings(settingsPath(configDir), tauriSettingsPath(configDir));
  const settings = new Settings(settingsPath(configDir));
  let mainWindow: BrowserWindow | null = null;

  const openExternal = (url: string) => shell.openExternal(url);
  // Only the main window's top frame showing the bundled client may call the bridge.
  const trusted = (event: IpcEventLike) =>
    fromMainPage(event, mainWindow && !mainWindow.isDestroyed() ? { webContents: mainWindow.webContents, mainFrame: mainWindow.webContents.mainFrame } : null, (url) => isAppPage(url, devUrl));
  const context: ShellContext = {
    registry: new IpcRegistry(trusted),
    events: new ShellEvents(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)),
    settings,
    mainWindow: () => mainWindow,
    showMain: () => showMain(mainWindow),
    devUrl,
    icon,
    openExternal,
  };
  const version = appVersion();
  const connect = new ConnectWindow({ devUrl, icon, openExternal: (url) => void openExternal(url) });
  // The signed feed (updater.ts): fetched through Chromium's network stack like the node resolver.
  const feed = updaterSetup({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    arch: process.arch,
    fetch: (url) => net.fetch(url, { signal: AbortSignal.timeout(30_000) }),
  });
  const updates = !!feed;
  // The keychain is chosen once the app is ready (safeStorage knows its keyring only then); no call comes earlier.
  let keychain: Keychain | null = null;
  const keychainNow = () =>
    app.isReady() ? (keychain ??= Keychain.forSetting(process.env[BACKEND_ENV], { dir: app.getPath("userData"), cipher: safeStorageCipher(safeStorage) })) : Keychain.unavailable();
  let quitting = false;
  const quit = () => app.quit();
  const tray = new TrayController({
    createHost: (onMenu, onClick) => electronTrayHost({ Tray, Menu, nativeImage }, decodePng(readFileSync(trayLogo)), onMenu, onClick),
    settings,
    events: context.events,
    windowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
    showMain: context.showMain,
    hideMain: () => mainWindow?.hide(),
    quit,
  });
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
  app.on("before-quit", () => {
    quitting = true;
    downloads.abortAll();
  });
  // The parts of the shell; each registers its handlers on the registry (src/main/context.ts).
  const parts: ShellPart[] = [
    (ctx) =>
      registerShellHandlers(ctx.registry, {
        settings: ctx.settings,
        version,
        updater: updates,
        openExternal: ctx.openExternal,
        // Chromium's network stack: verified TLS with the system's trust store, the system's proxy settings.
        resolve: (domain) => resolveNode(domain, new HttpFetcher((url, init) => net.fetch(url, init), version), systemSrv),
        connect: { open: (url) => connect.open(url), close: () => connect.close() },
      }),
    (ctx) => registerUpdaterHandlers(ctx.registry, feed, undefined, channelSetting(ctx.settings, version)),
    (ctx) => registerKeychainHandlers(ctx.registry, { settings: ctx.settings, keychain: keychainNow }),
    // Notifications and the tray; their clicks come back to the client as shell events.
    (ctx) =>
      registerNotifyHandlers(ctx.registry, {
        notifier: new Notifier({ create: (o) => new Notification(o), supported: () => Notification.isSupported(), showMain: ctx.showMain, events: ctx.events, icon: ctx.icon }),
      }),
    (ctx) => registerTrayHandlers(ctx.registry, { tray, settings: ctx.settings, quit }),
    (ctx) => registerFilesHandlers(ctx.registry, { downloads }),
    // System-wide hotkeys: the native key listener (observes, never grabs), copied next to the main process by the build.
    (ctx) => {
      const hotkeys = new Hotkeys(nativeKeyListener(join(here, "../native/keywatch.node")), (event) => void ctx.events.send({ channel: "hotkeys", event }));
      registerHotkeyHandlers(ctx.registry, { hotkeys });
      app.on("will-quit", () => hotkeys.shutdown());
    },
  ];
  for (const part of parts) part(context);
  context.registry.install(ipcMain);

  app.on("second-instance", () => context.showMain());
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
    // Before any page loads: no spellchecker, so Chromium downloads no dictionaries (hardening.ts).
    disableSpellChecker([ses, session.fromPartition(CONNECT_PARTITION)]);
    installAppProtocol(ses.protocol, webRoot);
    const fromMain = (contents: Electron.WebContents | null) => !!mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents;
    ses.setPermissionRequestHandler((contents, name, callback, details) =>
      callback(permission(name, details.requestingUrl, fromMain(contents), devUrl, "mediaTypes" in details ? (details.mediaTypes ?? []) : [])),
    );
    ses.setPermissionCheckHandler((contents, name, origin, details) => permission(name, details.requestingUrl ?? origin, fromMain(contents), devUrl));
    ses.setDevicePermissionHandler(() => false);
    ses.on("will-download", (_event, item, contents) => handleWillDownload(item, fromMain(contents), downloads));
    installDisplayMediaHandler(ses, { mainWindow: () => mainWindow, isApp: (origin) => isAppPage(origin, devUrl), preload: join(here, "../preload/picker.cjs"), locale: () => app.getLocale() });
    tray.create();
    mainWindow = createMainWindow({ preload: join(here, "../preload/index.cjs"), icon, devUrl, openExternal: (url) => void openExternal(url) });
    attachWindow(mainWindow, tray, () => quitting);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });
}

main();
