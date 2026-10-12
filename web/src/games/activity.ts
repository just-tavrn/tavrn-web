// SPDX-License-Identifier: Apache-2.0
/**
 * Game activity (docs/DESKTOP.md "Game activity"): while the setting is on, the shell watches for the games of the list
 * (`platform().games`) and names the one in front; the client publishes "Playing <name>" as the device's activity
 * (PROTOCOL.md §6a, `PUT /users/me/activity` to every node it has a session on) and clears it when the game closes,
 * the setting goes off or the client signs out. It never replaces an activity it did not set (one the user chose in the
 * status menu, or one of the local activity bridge), and it publishes nothing for a user who hides their activity.
 * Platform-independent: the members come in, so tests pass fakes.
 */
import type { Activity, MyPresence } from "@tavrn/sdk";
import type { GameEntry, PlatformGames } from "../platform/types";

export interface GameActivityOptions {
  games: PlatformGames;
  /** The list to watch now (empty: the setting is off). */
  list: () => GameEntry[];
  /** Calls `fn` whenever the list may have changed; returns the unsubscriber. */
  onListChange: (fn: () => void) => () => void;
  /** The own presence as the home node knows it (the current activity, `hide_activity`). */
  mine: () => MyPresence | null;
  publish: (activity: Activity | null) => Promise<void>;
  /** The shell's answer: whether this system can tell the program in front. */
  onSupported?: (supported: boolean) => void;
}

/** Starts the watch; returns the stopper (which stops the shell's watch and clears what it published). */
export function startGameActivity({ games, list, onListChange, mine, publish, onSupported }: GameActivityOptions): () => void {
  let ours: string | null = null;
  let stopped = false;
  const isOurs = () => {
    const current = mine()?.activity ?? null;
    return !!ours && !!current && current.type === "playing" && current.name === ours && !current.application;
  };
  const clear = () => {
    if (ours === null) return;
    const still = isOurs();
    ours = null;
    if (still) void publish(null).catch(() => undefined);
  };
  const show = (name: string | null) => {
    if (stopped) return;
    if (name === null) return clear();
    const me = mine();
    if (me?.hide_activity) return;
    const current = me?.activity ?? null;
    // Somebody else's activity (the status menu, an application through the bridge) stays.
    if (current && !isOurs()) return;
    if (ours === name && isOurs()) return;
    ours = name;
    void publish({ type: "playing", name }).catch(() => {
      ours = null;
    });
  };
  const offGame = games.onGame(show);
  const sync = () => {
    const entries = list();
    if (entries.length === 0) clear();
    void games
      .watch(entries)
      .then((ok) => onSupported?.(ok))
      .catch(() => undefined);
  };
  const offList = onListChange(sync);
  sync();
  return () => {
    stopped = true;
    offGame();
    offList();
    void games.watch([]).catch(() => undefined);
    clear();
  };
}
