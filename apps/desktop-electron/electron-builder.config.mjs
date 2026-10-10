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
  extraMetadata: { name: "tavrn", version, main: "dist/main/index.js" },
  directories: { output: "release", buildResources: "build" },
  asar: true,
  asarUnpack: ["dist/native/*.node"],
  files: [
    "package.json",
    "dist/main/**/*.js",
    "dist/shared/**/*.js",
    "dist/preload/index.cjs",
    // The key listener (native/keywatch, docs/DESKTOP.md "Hotkeys"): a native module is loaded from outside the archive.
    "dist/native/keywatch.node",
    { from: "../../web/dist", to: "web", filter: ["**/*", "!**/*.map"] },
    { from: "../desktop/src-tauri/icons", to: "icons", filter: ["icon.png"] },
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
  deb: { packageName: "tavrn" },
};
