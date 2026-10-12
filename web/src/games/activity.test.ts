// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { Activity, MyPresence } from "@tavrn/sdk";
import type { GameEntry, PlatformGames } from "../platform/types";
import { startGameActivity } from "./activity";

function setup(opts: { list?: GameEntry[]; hidden?: boolean; supported?: boolean } = {}) {
  let onGame: ((name: string | null) => void) | null = null;
  let listChanged: (() => void) | null = null;
  const watched: GameEntry[][] = [];
  const games: PlatformGames = {
    watch: vi.fn(async (entries: GameEntry[]) => {
      watched.push(entries);
      return opts.supported ?? true;
    }),
    onGame: (fn) => {
      onGame = fn;
      return () => {
        onGame = null;
      };
    },
  };
  let list = opts.list ?? [{ process: "factorio", name: "Factorio" }];
  let mine = { status: "online", effective: "online", idle: false, custom_status: null, activity: null, hide_activity: opts.hidden ?? false } as unknown as MyPresence;
  const published: Array<Activity | null> = [];
  // The home node answers with the new presence (pushActivity does setMine).
  const publish = vi.fn(async (a: Activity | null) => {
    published.push(a);
    mine = { ...mine, activity: a ? { ...a, started_at: "2026-10-12T20:00:00Z" } : null } as MyPresence;
  });
  const supported: boolean[] = [];
  const stop = startGameActivity({
    games,
    list: () => list,
    onListChange: (fn) => {
      listChanged = fn;
      return () => {
        listChanged = null;
      };
    },
    mine: () => mine,
    publish,
    onSupported: (ok) => supported.push(ok),
  });
  return {
    stop,
    watched,
    published,
    supported,
    game: (name: string | null) => onGame?.(name),
    setList: (next: GameEntry[]) => {
      list = next;
      listChanged?.();
    },
    setMine: (patch: Partial<MyPresence>) => {
      mine = { ...mine, ...patch } as MyPresence;
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
  };
}

describe("game activity", () => {
  it("publishes Playing <game> while it is in front and clears it when it closes", async () => {
    const s = setup();
    await s.flush();
    expect(s.watched).toEqual([[{ process: "factorio", name: "Factorio" }]]);
    expect(s.supported).toEqual([true]);
    s.game("Factorio");
    await s.flush();
    s.game("Factorio");
    await s.flush();
    expect(s.published).toEqual([{ type: "playing", name: "Factorio" }]);
    s.game(null);
    await s.flush();
    expect(s.published).toEqual([{ type: "playing", name: "Factorio" }, null]);
  });

  it("switching the setting off stops the watch and clears the activity; signing out does too", async () => {
    const s = setup();
    s.game("Factorio");
    await s.flush();
    s.setList([]);
    await s.flush();
    expect(s.watched.at(-1)).toEqual([]);
    expect(s.published.at(-1)).toBeNull();
    s.setList([{ process: "factorio", name: "Factorio" }]);
    s.game("Factorio");
    await s.flush();
    s.stop();
    await s.flush();
    expect(s.watched.at(-1)).toEqual([]);
    expect(s.published).toEqual([{ type: "playing", name: "Factorio" }, null, { type: "playing", name: "Factorio" }, null]);
    s.game("Factorio");
    expect(s.published).toHaveLength(4);
  });

  it("never replaces or clears an activity it did not set", async () => {
    const s = setup();
    s.setMine({ activity: { type: "listening", name: "Radio" } as Activity });
    s.game("Factorio");
    await s.flush();
    expect(s.published).toEqual([]);
    s.setMine({ activity: null });
    s.game("Factorio");
    await s.flush();
    // The user picks something else in the status menu while playing: the game's end leaves it alone.
    s.setMine({ activity: { type: "watching", name: "A film" } as Activity });
    s.game(null);
    await s.flush();
    expect(s.published).toEqual([{ type: "playing", name: "Factorio" }]);
  });

  it("publishes nothing for a user who hides their activity, and reports an unsupported system", async () => {
    const s = setup({ hidden: true, supported: false });
    s.game("Factorio");
    await s.flush();
    expect(s.published).toEqual([]);
    expect(s.supported).toEqual([false]);
  });
});
