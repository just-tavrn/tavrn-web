// SPDX-License-Identifier: Apache-2.0
// The preload, bundled into one CommonJS file (dist/preload/index.cjs): a sandboxed preload runs without a module loader
// of its own (it may require "electron" and nothing from disk). Types are erased; nothing of the client is bundled.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: "es2023",
    lib: { entry: "src/preload/index.ts", formats: ["cjs"], fileName: () => "index.cjs" },
    rolldownOptions: { external: ["electron"] },
  },
});
