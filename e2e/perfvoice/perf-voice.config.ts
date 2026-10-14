// SPDX-License-Identifier: Apache-2.0
// MEASUREMENT ONLY (not committed): the release node with its LiveKit child, and the bundle under test ($PERF_DIST)
// served by `vite preview` (API proxied to the node), so before and after run against the same node.
import { createSocket } from "node:dgram";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import "../ts-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeBin = process.env.E2E_NODE_BIN!;
const port = process.env.E2E_NODE_PORT ?? "8940";
const webPort = process.env.E2E_WEB_PORT ?? "5940";
const dist = process.env.PERF_DIST!;
const tsHooks = `--import=${new URL("../ts-packages.mjs", import.meta.url).href}`;
if (!process.env.NODE_OPTIONS?.includes(tsHooks)) process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, tsHooks, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" ");
mkdirSync(resolve(root, "data-dev"), { recursive: true });
async function routeAddress(): Promise<string | null> {
  return new Promise((done) => {
    const socket = createSocket("udp4");
    socket.on("error", () => done(null));
    socket.connect(9, "192.0.2.1", () => {
      const { address } = socket.address();
      socket.close();
      done(address);
    });
  });
}
const mediaAddress = process.env.E2E_MEDIA_IP ?? (await routeAddress());
const base = 20000 + (Number(port) % 250) * 150;
const plus = (n: number) => String(Number(port) + n);
const web = `http://localhost:${webPort}`;
const db = process.env.PERF_DB ?? "perfvoicefix";

export default defineConfig({
  testDir: ".",
  testMatch: "perf-voice.spec.ts",
  workers: 1,
  timeout: 1_200_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: { baseURL: web, locale: "de-DE", trace: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: `sh -c 'rm -f data-dev/${db}.db*; rm -rf data-dev/${db}; exec ${nodeBin} --dev >> data-dev/${db}-node.log 2>&1'`,
      cwd: root,
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        TAVRN_LISTEN: `127.0.0.1:${port}`,
        TAVRN_DATABASE_URL: `sqlite://data-dev/${db}.db?mode=rwc`,
        TAVRN_DATA_DIR: `data-dev/${db}`,
        TAVRN_WEBAUTHN_ORIGIN: web,
        TAVRN_PUBLIC_URL: `http://localhost:${port}`,
        RUST_LOG: "warn",
        TAVRN_VOICE_ENABLED: "true",
        TAVRN_LIVEKIT_PORT: plus(1000),
        TAVRN_RTC_UDP_PORT_RANGE: `${base}-${base + 149}`,
        TAVRN_VOICE_RECONNECT_GRACE_SECS: "5",
        TAVRN_RTC_TCP_PORT: plus(2000),
        TAVRN_RTC_TURN_ENABLED: "true",
        TAVRN_RTC_TURN_UDP_PORT: plus(2100),
        TAVRN_RTC_TURN_TLS_PORT: "0",
        TAVRN_RTC_TURN_RELAY_PORT_RANGE: `${31000 + (Number(port) % 250) * 20}-${31000 + (Number(port) % 250) * 20 + 19}`,
        ...(mediaAddress ? { TAVRN_RTC_EXTERNAL_IP: mediaAddress } : {}),
      },
    },
    {
      command: `pnpm --filter @tavrn/web exec vite preview --port ${webPort} --strictPort --outDir ${dist}`,
      cwd: root,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { E2E_NODE_PORT: port, E2E_WEB_PORT: webPort },
    },
  ],
});
