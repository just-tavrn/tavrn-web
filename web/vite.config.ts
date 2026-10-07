// SPDX-License-Identifier: Apache-2.0
/// <reference types="vitest/config" />
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In development the node runs on 127.0.0.1:8080 (`tavrn-node --dev`, see README.md); Vite forwards the API and
// discovery paths to it, so the client runs "on the same node" as in production, where the node serves the bundle.
// Ports can be overridden for parallel test runs (E2E_NODE_PORT, E2E_WEB_PORT).
const node = `http://127.0.0.1:${process.env.E2E_NODE_PORT ?? "8080"}`;
const webPort = Number(process.env.E2E_WEB_PORT ?? "5173");
// Two-node Playwright runs serve the client on 127.0.0.1 under the names a.test and b.test.
const host = process.env.E2E_WEB_HOST;
const allowedHosts = process.env.E2E_ALLOWED_HOSTS?.split(",").filter(Boolean);

/**
 * MediaPipe's WebAssembly runtime for the camera background effects (`@livekit/track-processors`) is
 * served by the node itself under `/mediapipe/` (copied into the build, served from node_modules in
 * development), never from a CDN: no third party learns who uses voice. The segmentation model lives in
 * `public/mediapipe/`.
 *
 * The runtime is taken from the `@mediapipe/tasks-vision` that `@livekit/track-processors` itself depends on (it
 * pins an exact version): its JavaScript is what the bundle runs, and MediaPipe's loader and WebAssembly module
 * only work as the pair of one release. A copy of another version (a direct dependency of the client) would serve
 * a runtime the bundled loader was not built for.
 */
function mediapipeAssets(): Plugin {
  const processors = createRequire(import.meta.url).resolve("@livekit/track-processors");
  const dir = join(dirname(createRequire(processors).resolve("@mediapipe/tasks-vision")), "wasm");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".wasm"));
  return {
    name: "tavrn-mediapipe-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/^\/mediapipe\/([\w.-]+)$/)?.[1];
        if (!name || !files.includes(name)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(join(dir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files) this.emitFile({ type: "asset", fileName: `mediapipe/${name}`, source: readFileSync(join(dir, name)) });
    },
  };
}

/**
 * The whiteboard (Excalidraw) loads its fonts from `EXCALIDRAW_ASSET_PATH` (`/assets/excalidraw/`, see
 * src/whiteboard/excalidraw.ts). This plugin serves them from the package in development and copies them
 * into the build, so no font comes from a CDN (CSP `font-src 'self'`). The CJK fallback font (Xiaolai,
 * 13 MB) is left out; CJK text falls back to the system fonts.
 */
function excalidrawFonts(): Plugin {
  const dir = resolve(__dirname, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const excluded = new Set(["Xiaolai"]);
  const prefix = "/assets/excalidraw/fonts/";
  const files = (): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) {
          if (!excluded.has(name)) walk(p);
        } else if (name.endsWith(".woff2")) out.push(p);
      }
    };
    walk(dir);
    return out;
  };
  return {
    name: "tavrn-excalidraw-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith(prefix)) return next();
        const file = resolve(dir, decodeURIComponent(url.slice(prefix.length)));
        // Only files below the font directory (no traversal), only woff2, not the excluded ones.
        if (!file.startsWith(dir + sep) || !file.endsWith(".woff2") || excluded.has(relative(dir, file).split(sep)[0] ?? "") || !existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "font/woff2");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const file of files()) {
        this.emitFile({ type: "asset", fileName: `assets/excalidraw/fonts/${relative(dir, file).split(sep).join("/")}`, source: readFileSync(file) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeAssets(), excalidrawFonts()],
  // Excalidraw's Mermaid import (text-to-diagram) is replaced by a stub: see src/whiteboard/mermaid-stub.ts.
  resolve: { alias: { "@excalidraw/mermaid-to-excalidraw": resolve(__dirname, "src/whiteboard/mermaid-stub.ts") } },
  server: {
    port: webPort,
    strictPort: true,
    ...(host ? { host } : {}),
    ...(allowedHosts?.length ? { allowedHosts } : {}),
    proxy: {
      "/api": { target: node, ws: true },
      "/.well-known": node,
      "/healthz": node,
      "/readyz": node,
    },
  },
  // The WebAssembly package is loaded with `init()` (fetches tavrn_crypto_bg.wasm next to the module);
  // pre-bundling would move the module away from its .wasm file.
  optimizeDeps: { exclude: ["@tavrn/crypto"] },
  // Module workers: LiveKit's E2EE worker and the voice AudioWorklets (`?worker&url`).
  worker: { format: "es" },
  // The whiteboard bundle (Excalidraw with its lazily loaded parts) is large but only loaded with a board.
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 2500 },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
