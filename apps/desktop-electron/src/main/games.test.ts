// SPDX-License-Identifier: Apache-2.0
// Game activity of the Electron shell (the cases of the Tauri shell's games.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameWatch, INTERVAL_MS, MAX_ENTRIES, registerGamesHandlers, validEntry, type GameEntry } from "./games.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";

function fakeTimers() {
  const timers = { handle: null as unknown, ms: 0, cleared: 0 };
  return {
    timers,
    impl: {
      setInterval: (_f: () => void, ms: number) => {
        timers.ms = ms;
        timers.handle = {};
        return timers.handle;
      },
      clearInterval: () => void timers.cleared++,
    },
  };
}

test("entries are plain process names with a display name", () => {
  assert.ok(validEntry({ process: "eldenring.exe", name: "ELDEN RING" }));
  for (const bad of [null, "x", { process: "x" }, { process: "", name: "X" }, { process: "x", name: " " }, { process: "/usr/bin/x", name: "X" }, { process: "C:\\x.exe", name: "X" }, { process: "a".repeat(65), name: "X" }, { process: "x", name: "n".repeat(129) }, { process: "x", name: "X", extra: 1 }]) {
    assert.ok(!validEntry(bad), JSON.stringify(bad));
  }
});

test("a game is reported when it changes, null once when it closes or the watch stops", () => {
  let front: string | null = null;
  const lists: GameEntry[][] = [];
  const seen: Array<string | null> = [];
  const { timers, impl } = fakeTimers();
  const games = new GameWatch((list) => (lists.push(list), front), (n) => seen.push(n), impl);
  games.watch([{ process: " factorio ", name: " Factorio " }]);
  assert.equal(timers.ms, INTERVAL_MS);
  assert.deepEqual(lists[0], [{ process: "factorio", name: "Factorio" }]);
  front = "Factorio";
  games.tick();
  games.tick();
  front = null;
  games.tick();
  front = "Factorio";
  games.tick();
  games.watch([]);
  games.tick();
  assert.deepEqual(seen, ["Factorio", null, "Factorio", null]);
  assert.equal(timers.cleared, 1);
});

test("without the native module nothing is watched", () => {
  const seen: Array<string | null> = [];
  const { timers, impl } = fakeTimers();
  const games = new GameWatch(null, (n) => seen.push(n), impl);
  assert.equal(games.watch([{ process: "factorio", name: "Factorio" }]), false);
  assert.equal(timers.handle, null);
  assert.deepEqual(seen, []);
});

test("gamesWatch takes only a checked list", async () => {
  const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };
  const registry = new IpcRegistry((e) => e === me);
  const { impl } = fakeTimers();
  const games = new GameWatch(() => null, () => {}, impl);
  registerGamesHandlers(registry, { games });
  const call = (...args: unknown[]) => registry.dispatch("tavrn:games.gamesWatch", "gamesWatch", me, args);
  assert.equal((await call([{ process: "factorio", name: "Factorio" }])).ok, true);
  assert.equal((await call([])).ok, true);
  for (const bad of [[[{ process: "/x", name: "X" }]], [Array(MAX_ENTRIES + 1).fill({ process: "x", name: "X" })], ["x"], []]) {
    assert.deepEqual(await call(...bad), { ok: false, error: "ipc.invalid_arguments" });
  }
});
