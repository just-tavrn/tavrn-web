// SPDX-License-Identifier: Apache-2.0
// The Electron shell's smoke test (docs/DESKTOP.md "The Linux shell (Electron)"): one tavrn node in development mode
// (E2E_NODE_BIN, port E2E_NODE_PORT, default 8300, a fresh database in data-dev/electron-<port>) with this checkout's
// client on a Vite dev server as its web client (E2E_WEB_PORT, default 5300: the sign-in window shows it), or a running
// node (E2E_NODE_URL), and the app driven by Playwright's Electron driver (the packaged app over CDP). Always under
// xvfb-run (just electron-e2e).
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { nodePort, repoDir, webOrigin, webPort } from "./harness.ts";

const nodeBin = process.env.E2E_NODE_BIN?.trim();
const external = process.env.E2E_NODE_URL?.trim();
if (!nodeBin && !external) throw new Error("set E2E_NODE_BIN to a tavrn-node binary (or E2E_NODE_URL to a running development node)");
const data = resolve(repoDir, "data-dev", `electron-${nodePort}`);
// A fresh database per run, cleaned by the runner only: every worker loads this file again while the node runs.
if (!external && process.env.TEST_WORKER_INDEX === undefined) {
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../test-results",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: external
    ? undefined
    : [
        {
          command: `${quote(nodeBin!)} --dev`,
          cwd: repoDir,
          url: `http://127.0.0.1:${nodePort}/healthz`,
          // Never a node left over from another run (its database may be gone): the port must be free.
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            TAVRN_LISTEN: `127.0.0.1:${nodePort}`,
            TAVRN_DATABASE_URL: `sqlite://${data}/node.db?mode=rwc`,
            TAVRN_DATA_DIR: `${data}/data`,
            TAVRN_VOICE_ENABLED: "false",
            // The node's web client (its /connect page in the sign-in window) is this checkout's, on the dev server.
            TAVRN_WEBAUTHN_ORIGIN: webOrigin,
          },
        },
        {
          command: "pnpm --filter @tavrn/web dev",
          cwd: repoDir,
          url: webOrigin,
          reuseExistingServer: false,
          timeout: 120_000,
          env: { E2E_NODE_PORT: String(nodePort), E2E_WEB_PORT: String(webPort) },
        },
      ],
});
