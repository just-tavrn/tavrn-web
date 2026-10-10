// SPDX-License-Identifier: Apache-2.0
// electron-builder (MIT): the Linux packages of the Electron shell, `.AppImage` and `.deb` (pnpm package, just
// electron-package; docs/DESKTOP.md "The Linux shell (Electron)"). The app's version is web/package.json's; the main
// process, the preload and the bundled client (web/dist without source maps) go into the asar archive; the icons are
// the Tauri app's. Electron's fuses switch off what an app that never runs foreign code does not need.
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8")).version;

/** @type {import("electron-builder").Configuration} */
export default {
  appId: "org.tavrn.desktop",
  productName: "Tavrn",
  executableName: "tavrn",
  copyright: "Copyright 2026 The tavrn authors",
  // desktopName: the window's WM_CLASS / app id matches the menu entry (tavrn.desktop).
  extraMetadata: { name: "tavrn", version, main: "dist/main/index.js", desktopName: "tavrn.desktop" },
  directories: { output: "release", buildResources: "build" },
  asar: true,
  files: [
    "package.json",
    "dist/main/**/*.js",
    "dist/shared/**/*.js",
    "dist/preload/*.cjs",
    "!**/*.map",
    { from: "../../web/dist", to: "web", filter: ["**/*", "!**/*.map"] },
    { from: "../desktop/src-tauri/icons", to: "icons", filter: ["icon.png", "128x128@2x.png"] },
  ],
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
  // The update feed (electron-updater, src/main/updater.ts): written into the package as resources/app-update.yml;
  // the release attaches latest-linux.yml. Packages are built with `--publish never`; release.yml uploads.
  publish: [{ provider: "github", owner: "just-tavrn", repo: "tavrn-web", releaseType: "release" }],
};
