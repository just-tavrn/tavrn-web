// SPDX-License-Identifier: Apache-2.0
/**
 * The game activity setting of this device (docs/DESKTOP.md "Game activity"), off by default: whether the app shows
 * "Playing <game>", which entries of the built-in list are switched off and the user's own entries. Kept in
 * localStorage (`tavrn.games`): the programs of one computer are none of another device's business.
 */
import { create } from "zustand";
import type { GameEntry } from "../platform/types";
import { KNOWN_GAMES } from "./known";

export interface GameSettings {
  enabled: boolean;
  /** Process names of built-in entries switched off. */
  off: string[];
  own: GameEntry[];
}

const KEY = "tavrn.games";
export const MAX_OWN = 100;
export const DEFAULT_GAMES: GameSettings = { enabled: false, off: [], own: [] };

/** A valid entry (the shells' rules): a plain process name of at most 64 bytes, a display name of at most 128. */
export function validEntry(e: { process: string; name: string }): boolean {
  const p = e.process.trim();
  const n = e.name.trim();
  return p.length > 0 && new TextEncoder().encode(p).length <= 64 && !/[\p{Cc}/\\]/u.test(p) && n.length > 0 && [...n].length <= 128 && !/\p{Cc}/u.test(n);
}

const key = (process: string) => process.trim().toLowerCase();

export function parseGames(raw: unknown): GameSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const off = Array.isArray(r.off) ? r.off.filter((p): p is string => typeof p === "string").slice(0, KNOWN_GAMES.length) : [];
  const own = Array.isArray(r.own)
    ? r.own
        .filter((e): e is GameEntry => !!e && typeof e === "object" && typeof (e as GameEntry).process === "string" && typeof (e as GameEntry).name === "string" && validEntry(e as GameEntry))
        .map((e) => ({ process: e.process.trim(), name: e.name.trim() }))
        .slice(0, MAX_OWN)
    : [];
  return { enabled: r.enabled === true, off, own };
}

/** What the shell watches: nothing while off, else the built-in entries that are on and the own ones. */
export function watchList(s: GameSettings): GameEntry[] {
  if (!s.enabled) return [];
  const off = new Set(s.off.map(key));
  return [...KNOWN_GAMES.filter((g) => !off.has(key(g.process))), ...s.own];
}

function readLocal(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return parseGames(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_GAMES;
  }
}

/** Whether the shell can tell the program in front (its answer to the last watch; null before one). Not stored. */
export const useGameSupport = create<{ supported: boolean | null }>(() => ({ supported: null }));

interface State extends GameSettings {
  setEnabled: (on: boolean) => void;
  setKnown: (process: string, on: boolean) => void;
  /** Adds an own entry (a process already listed is replaced); false when it is invalid or the list is full. */
  addOwn: (entry: GameEntry) => boolean;
  removeOwn: (process: string) => void;
}

export const useGames = create<State>((set, get) => {
  const save = (patch: Partial<GameSettings>) => {
    const { enabled, off, own } = get();
    const next = parseGames({ enabled, off, own, ...patch });
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage disabled: memory only */
    }
    set(next);
  };
  return {
    ...readLocal(),
    setEnabled: (on) => save({ enabled: on }),
    setKnown: (process, on) => {
      const rest = get().off.filter((p) => key(p) !== key(process));
      save({ off: on ? rest : [...rest, process] });
    },
    addOwn: (entry) => {
      const e = { process: entry.process.trim(), name: entry.name.trim() };
      const rest = get().own.filter((o) => key(o.process) !== key(e.process));
      if (!validEntry(e) || rest.length >= MAX_OWN) return false;
      save({ own: [...rest, e] });
      return true;
    },
    removeOwn: (process) => save({ own: get().own.filter((o) => key(o.process) !== key(process)) }),
  };
});
