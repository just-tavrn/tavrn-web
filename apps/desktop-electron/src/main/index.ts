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
import { app, BrowserWindow, ipcMain, Menu, net, protocol, session, shell } from "electron";
import { installDisplayMediaHandler } from "./capture.ts";
import { DIR_NAME, Settings, importTauriSettings, settingsPath, tauriSettingsPath } from "./config.ts";
import { ConnectWindow } from "./connect.ts";
import type { ShellContext, ShellPart } from "./context.ts";
import { ShellEvents } from "./events.ts";
import { devServerUrl, isAppPage, permission } from "./guard.ts";
import { IpcRegistry, fromMainPage, type IpcEventLike } from "./ipc.ts";
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, installAppProtocol } from "./protocol.ts";
import { HttpFetcher, resolveNode, systemSrv } from "./resolve.ts";
import { registerShellHandlers } from "./shell.ts";
import { registerUpdaterHandlers, updaterConfigured } from "./updater.ts";
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
  const devUrl = devServerUrl(app.isPackaged, process.env.TAVRN_DESKTOP_DEV_URL);
  const webRoot = app.isPackaged ? join(app.getAppPath(), "web") : resolve(app.getAppPath(), "../../web/dist");
  const icon = app.isPackaged ? join(app.getAppPath(), "icons", "icon.png") : resolve(app.getAppPath(), "../desktop/src-tauri/icons/icon.png");
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
  const updates = updaterConfigured(app.isPackaged, process.resourcesPath);
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
    (ctx) => registerUpdaterHandlers(ctx.registry, updates),
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
    installAppProtocol(ses.protocol, webRoot);
    const fromMain = (contents: Electron.WebContents | null) => !!mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents;
    ses.setPermissionRequestHandler((contents, name, callback, details) =>
      callback(permission(name, details.requestingUrl, fromMain(contents), devUrl, "mediaTypes" in details ? (details.mediaTypes ?? []) : [])),
    );
    ses.setPermissionCheckHandler((contents, name, origin, details) => permission(name, details.requestingUrl ?? origin, fromMain(contents), devUrl));
    ses.setDevicePermissionHandler(() => false);
    installDisplayMediaHandler(ses, { mainWindow: () => mainWindow, isApp: (origin) => isAppPage(origin, devUrl), preload: join(here, "../preload/picker.cjs"), locale: () => app.getLocale() });
    mainWindow = createMainWindow({ preload: join(here, "../preload/index.cjs"), icon, devUrl, openExternal: (url) => void openExternal(url) });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });
}

main();
