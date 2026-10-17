// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE } from "./helpers";
import { scaled } from "./timeouts";

/** The e2e package (its node_modules hold vite-node and the installed @tavrn/bot). */
const E2E = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Starts a bot of fixtures/ on the installed @tavrn/bot runtime (default: the example bot, fixtures/echo-bot.ts) against
 * the e2e node with the given app token, its key file and state in `dir`, and waits for its `ready` line.
 * An absolute fixture path runs the optional bot-platform raid fixture from its repository with its own tsx loader.
 */
export async function startExampleBot(app: { secret: string; botUsername: string }, dir: string, fixture = "fixtures/echo-bot.ts"): Promise<ChildProcess> {
  const external = isAbsolute(fixture);
  const child = spawn(external ? process.execPath : join(E2E, "node_modules", ".bin", "vite-node"), external ? ["--import", "tsx", fixture] : [fixture], {
    cwd: external ? resolve(dirname(fixture), "..") : E2E,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(external ? { E2E_RAID_BOT: "1" } : {}),
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
