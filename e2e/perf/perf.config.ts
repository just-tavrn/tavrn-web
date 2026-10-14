// SPDX-License-Identifier: Apache-2.0
// Client performance runs: `pnpm exec playwright test -c perf/perf.config.ts` runs the specs named *.perf.ts (helpers in
// instrument.ts). Chromium only, one worker, fake media devices, no servers started here: a tavrn-node (a release build,
// so the node's latency does not distort the client's numbers) and the web client (Vite dev server for readable
// component names, `vite preview` of the production bundle for timings) must already run on E2E_NODE_PORT and
// E2E_WEB_PORT. Results go to perf/results/ (not committed).
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import "../ts-packages.mjs";
import { speechWav } from "../tests/fake-audio.ts";

const tsHooks = `--import=${new URL("../ts-packages.mjs", import.meta.url).href}`;
if (!process.env.NODE_OPTIONS?.includes(tsHooks)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, tsHooks, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" ");
}
const webPort = process.env.E2E_WEB_PORT ?? "5173";
const voice = join(tmpdir(), "tavrn-perf-voice.wav");
writeFileSync(voice, speechWav(5));

export default defineConfig({
  testDir: ".",
  testMatch: "*.perf.ts",
  workers: 1,
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: {
    baseURL: `http://localhost:${webPort}`,
    locale: "de-DE",
    trace: "off",
    actionTimeout: 30_000,
    permissions: ["microphone", "camera"],
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${voice}`, "--autoplay-policy=no-user-gesture-required"] },
      },
    },
  ],
});
