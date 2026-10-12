// SPDX-License-Identifier: Apache-2.0
// The Electron shell's smoke test (docs/DESKTOP.md "The Linux shell (Electron)"): one tavrn node in development mode
// (E2E_NODE_BIN, port E2E_NODE_PORT, default 8300, a fresh database in data-dev/electron-<port>) with this checkout's
// client on a Vite dev server as its web client (E2E_WEB_PORT, default 5300: the sign-in window shows it), or a running
// node (E2E_NODE_URL), and the app driven by Playwright's Electron driver (the packaged app over CDP). Always under
// xvfb-run (just electron-e2e).
import { createSocket } from "node:dgram";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { scaled } from "../../../e2e/tests/timeouts.ts";
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

/**
 * Voice for the full smoke test (electron-smoke.spec.ts): the node supervises its own livekit-server (on the PATH, or
 * TAVRN_LIVEKIT_BINARY) on ports derived from the node port, as the end-to-end suite does (e2e/playwright.config.ts);
 * E2E_VOICE=false switches it off. LiveKit announces the machine's address on its default route (no packet is sent).
 */
const voice = process.env.E2E_VOICE ?? "true";
const mediaAddress =
  process.env.E2E_MEDIA_IP ??
  (await new Promise<string | null>((done) => {
    const socket = createSocket("udp4");
    socket.on("error", () => done(null));
    socket.connect(9, "192.0.2.1", () => {
      const { address } = socket.address();
      socket.close();
      done(address);
    });
  }));
const udpBase = 20000 + (nodePort % 250) * 150;
const voiceEnv: Record<string, string> =
  voice === "true"
    ? {
        TAVRN_VOICE_ENABLED: "true",
        TAVRN_LIVEKIT_PORT: String(nodePort + 1000),
        TAVRN_RTC_UDP_PORT_RANGE: `${udpBase}-${udpBase + 149}`,
        TAVRN_RTC_TCP_PORT: String(nodePort + 2000),
        TAVRN_RTC_TURN_ENABLED: "false",
        ...(mediaAddress ? { TAVRN_RTC_EXTERNAL_IP: mediaAddress } : {}),
      }
    : { TAVRN_VOICE_ENABLED: "false" };

const ci = !!process.env.CI;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../test-results",
  workers: 1,
  // Every limit scaled by TAVRN_TEST_TIMEOUT_FACTOR (e2e/tests/timeouts.ts), like the main suite.
  timeout: scaled(180_000),
  expect: { timeout: scaled(20_000) },
  // One retry in CI as a safety net, never as the fix: the JSON report feeds the desktop workflow's "N flaky" line.
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["json", { outputFile: "../test-results/results.json" }]] : "list",
  use: { trace: ci ? "on-first-retry" : "retain-on-failure", screenshot: "only-on-failure" },
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
            ...voiceEnv,
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
