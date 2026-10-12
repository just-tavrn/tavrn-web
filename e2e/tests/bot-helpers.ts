// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE } from "./helpers";
import { scaled } from "./timeouts";

/** The e2e package (its node_modules hold vite-node and the installed @tavrn/bot). */
const E2E = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Starts the example bot (fixtures/echo-bot.ts on the installed @tavrn/bot runtime) against the e2e node with the
 * given app token, its key file and state in `dir`, and waits for its `ready` line.
 */
export async function startExampleBot(app: { secret: string; botUsername: string }, dir: string): Promise<ChildProcess> {
  const child = spawn(join(E2E, "node_modules", ".bin", "vite-node"), ["fixtures/echo-bot.ts"], {
    cwd: E2E,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TAVRN_BOT_NODE: NODE,
      TAVRN_BOT_TOKEN: app.secret,
      TAVRN_BOT_KEY_FILE: join(dir, `tavrn-key-${app.botUsername}.txt`),
      TAVRN_BOT_STATE_DIR: join(dir, "state"),
    },
  });
  let log = "";
  child.stderr?.on("data", (d: Buffer) => {
    log = (log + d.toString()).slice(-4000);
  });
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`example bot not ready:\n${log}`)), scaled(60_000));
    child.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("ready ")) {
        clearTimeout(timer);
        ready();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`example bot exited (${code}):\n${log}`));
    });
  });
  return child;
}
