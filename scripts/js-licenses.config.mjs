// SPDX-License-Identifier: Apache-2.0
// The configuration of scripts/check-js-licenses.mjs: the production dependencies of the web client (@tavrn/web,
// everything that ends up in the bundle), of the end-to-end suite and of the desktop apps' packages (the Tauri and the
// Electron shell; the Tauri shell's Rust crates: `cargo deny`, apps/desktop/src-tauri/deny.toml). The client must stay
// app-store compatible and Apache-2.0; MPL-2.0 (on the common list) covers @tavrn/crypto and @tavrn/e2ee, file-level
// copyleft only (LICENSE.md). Development dependencies (Vite, Vitest, Playwright, TypeScript) are not shipped.
export default {
  packages: ["web", "e2e", "apps/desktop", "apps/desktop-electron"],
  allowed: [
    // Permissive licenses without copyleft, used by the Electron shell's updater (electron-updater): sax (XML of the
    // release feed) is BlueOak-1.0.0, argparse (through js-yaml) is the Python Software Foundation License.
    "BlueOak-1.0.0",
    "Python-2.0",
  ],
  // Packages whose metadata carries no SPDX license, verified against their license file.
  verified: { khroma: "MIT" },
  exceptions: {},
};
