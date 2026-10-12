// SPDX-License-Identifier: Apache-2.0
// electron-builder (MIT): the packages of the Electron shell: Linux `.AppImage` and `.deb` (pnpm package, just
// electron-package), and the Windows fallback, an NSIS installer (pnpm package:win, on Windows; docs/DESKTOP.md "The
// Linux shell (Electron)", "Builds and releases"). The app's version is web/package.json's; the main process, the
// preload and the bundled client (web/dist without source maps) go into the asar archive; the icons are the Tauri
// app's. Electron's fuses switch off what an app that never runs foreign code does not need.
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8")).version;
// The update key of both shells (docs/DESKTOP.md "Updates"): the public key of the Tauri updater, which also verifies
// the signed feeds of this shell (src/main/updater.ts reads it from the packaged package.json).
const updaterPubkey = JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")).plugins.updater.pubkey;

/** @type {import("electron-builder").Configuration} */
export default {
  appId: "org.tavrn.desktop",
  productName: "Tavrn",
  executableName: "tavrn",
  copyright: "Copyright 2026 The tavrn authors",
  // desktopName: the window's WM_CLASS / app id matches the menu entry (tavrn.desktop).
  extraMetadata: { name: "tavrn", version, main: "dist/main/index.js", desktopName: "tavrn.desktop", tavrn: { updaterPubkey } },
  directories: { output: "release", buildResources: "build" },
  asar: true,
  asarUnpack: ["dist/native/*.node"],
  files: [
    "package.json",
    "dist/main/**/*.js",
    "dist/shared/**/*.js",
    "dist/preload/*.cjs",
    // The key listener (native/keywatch, docs/DESKTOP.md "Hotkeys (Electron)"): a native module is loaded from outside the archive.
    "dist/native/keywatch.node",
    "!**/*.map",
    { from: "../../web/dist", to: "web", filter: ["**/*", "!**/*.map"] },
    { from: "../desktop/src-tauri/icons", to: "icons", filter: ["icon.png", "128x128@2x.png"] },
  ],
  // Deep links (src/main/deeplink.ts, docs/DESKTOP.md "Links into the app"): `x-scheme-handler/tavrn` in the .desktop
  // entry of the .deb and the AppImage, the URL protocol in the Windows installer's registry.
  protocols: [{ name: "tavrn", schemes: ["tavrn"] }],
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    enableCookieEncryption: true,
    grantFileProtocolExtraPrivileges: false,
  },
  linux: {
    target: ["AppImage", "deb"],
    icon: "../desktop/src-tauri/icons",
    category: "Network",
    synopsis: "Federated community chat with end-to-end encrypted conversations",
    description:
      "tavrn is a federated, self-hostable community chat: rooms with text, voice, announcement, files and forum channels, direct messages and friends across nodes, end-to-end encrypted conversations. The desktop app talks to the home node you choose.",
    maintainer: "tavrn",
    vendor: "tavrn",
  },
  // The licence and terms the Tauri installers show (apps/desktop/LICENSE.txt, "Licence and terms in the installers"):
  // next to the app in every package, and as /usr/share/doc/tavrn/LICENSE.txt in the .deb.
  extraResources: [{ from: "../desktop/LICENSE.txt", to: "LICENSE.txt" }],
  deb: {
    packageName: "tavrn",
    // electron-builder's list plus what Electron's binary links that minimal systems lack (ALSA, GBM).
    depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libasound2t64 | libasound2", "libgbm1"],
    fpm: ["../desktop/LICENSE.txt=/usr/share/doc/tavrn/LICENSE.txt"],
  },
  // The Windows fallback for machines where WebView2 causes trouble (the Tauri installer stays the recommended one): an
  // NSIS installer per user, like the Tauri one, with the same licence page and icon. Its file name contains "electron"
  // (the download page tells the two Windows builds apart by name); its own app id, start menu entry and uninstall
  // entry keep it apart from an installed Tauri app. Not code-signed yet (SmartScreen warns, as for the Tauri installer).
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "../desktop/src-tauri/icons/icon.ico",
    appId: "org.tavrn.desktop.electron",
  },
  nsis: {
    artifactName: "tavrn-electron_${version}_x64-setup.${ext}",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    license: "../desktop/LICENSE.txt",
    installerIcon: "../desktop/src-tauri/icons/icon.ico",
    uninstallerIcon: "../desktop/src-tauri/icons/icon.ico",
    shortcutName: "Tavrn (Electron)",
    uninstallDisplayName: "Tavrn (Electron) ${version}",
    deleteAppDataOnUninstall: false,
  },
  // The update feed (electron-updater, src/main/updater.ts): written into the package as resources/app-update.yml;
  // the release attaches latest-linux.yml (Linux) and latest.yml (Windows), each with its minisign signature
  // `<feed>.minisig`. Packages are built with `--publish never`; desktop.yml's release-assets job uploads.
  publish: [{ provider: "github", owner: "just-tavrn", repo: "tavrn-web", releaseType: "release" }],
};
