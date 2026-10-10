// SPDX-License-Identifier: Apache-2.0
// The preloads, each bundled into one CommonJS file (dist/preload/index.cjs for the main window, picker.cjs for the
// screen-share picker): a sandboxed preload runs without a module loader of its own (it may require "electron" and
// nothing from disk). Types are erased; nothing of the client is bundled.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: "es2023",
    lib: { entry: { index: "src/preload/index.ts", picker: "src/preload/picker.ts" }, formats: ["cjs"], fileName: (_format, name) => `${name}.cjs` },
    rolldownOptions: { external: ["electron"] },
  },
});
