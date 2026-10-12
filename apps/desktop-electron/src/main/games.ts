// SPDX-License-Identifier: Apache-2.0
/**
 * Game activity in the Electron shell (docs/DESKTOP.md "Game activity"), the Tauri shell's `games.rs`: opt-in, the
 * client hands its list of games (`games.gamesWatch`), and every few seconds the native module looks which program is in
 * front (`foregroundGame`, the crate `keywatch::games`: the process of the focused window on X11, Windows for the
 * fallback build). Only the display name of a listed game reaches the client, as the event `{ kind: "game", name }`
 * when it changes (`null` when it closed); window titles and other programs' names never leave the native module. An
 * empty list stops the watch and reports `null` once if a game was shown.
 */
import { createRequire } from "node:module";
import { check, type IpcRegistry } from "./ipc.ts";

export interface GameEntry {
  process: string;
  name: string;
}

/** The native module's function (`native/keywatch`), or why there is none. */
export type ForegroundGame = (entries: GameEntry[]) => string | null;

export const INTERVAL_MS = 5000;
export const MAX_ENTRIES = 300;

/** An entry as the native module checks it (it refuses the whole list otherwise): a plain process name, a display name. */
export function validEntry(e: unknown): e is GameEntry {
  if (typeof e !== "object" || e === null) return false;
  const { process, name } = e as Record<string, unknown>;
  if (typeof process !== "string" || typeof name !== "string" || Object.keys(e).length !== 2) return false;
  const p = process.trim();
  const n = name.trim();
  return p.length > 0 && new TextEncoder().encode(p).length <= 64 && !/[\p{Cc}/\\]/u.test(p) && n.length > 0 && [...n].length <= 128 && !/\p{Cc}/u.test(n);
}

/** The native module's `foregroundGame`, or null (not built: no game activity). */
export function nativeForegroundGame(file: string): ForegroundGame | null {
  try {
    const mod = createRequire(import.meta.url)(file) as { foregroundGame?: ForegroundGame };
    return typeof mod.foregroundGame === "function" ? mod.foregroundGame : null;
  } catch {
    return null;
  }
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export class GameWatch {
  readonly #detect: ForegroundGame | null;
  readonly #emit: (name: string | null) => void;
  readonly #timers: Timers;
  #list: GameEntry[] = [];
  #timer: unknown = null;
  #shown: string | null = null;

  constructor(detect: ForegroundGame | null, emit: (name: string | null) => void, timers: Timers = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) }) {
    this.#detect = detect;
    this.#emit = emit;
    this.#timers = timers;
  }

  /** Whether this build can tell the program in front (the native module is there and the system is X11 or Windows). */
  get supported(): boolean {
    return !!this.#detect && (process.platform === "linux" || process.platform === "win32");
  }

  /** Replaces the list (empty: stops); answers `supported`. */
  watch(entries: GameEntry[]): boolean {
    this.#list = entries.map((e) => ({ process: e.process.trim(), name: e.name.trim() }));
    if (this.#list.length === 0) {
      this.stop();
      return this.supported;
    }
    if (this.#detect && this.#timer === null) {
      this.#timer = this.#timers.setInterval(() => this.tick(), INTERVAL_MS);
      this.tick();
    }
    return this.supported;
  }

  /** One look; reports a change. */
  tick(): void {
    if (!this.#detect || this.#list.length === 0) return;
    let now: string | null = null;
    try {
      now = this.#detect(this.#list);
    } catch {
      now = null;
    }
    if (now === this.#shown) return;
    this.#shown = now;
    this.#emit(now);
  }

  stop(): void {
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
    this.#list = [];
    if (this.#shown !== null) {
      this.#shown = null;
      this.#emit(null);
    }
  }
}

/** The bridge's `games` namespace. */
export function registerGamesHandlers(registry: IpcRegistry, deps: { games: GameWatch }): void {
  const list: (v: unknown) => boolean = (v) => Array.isArray(v) && v.length <= MAX_ENTRIES && v.every(validEntry);
  registry.handle("games", "gamesWatch", check.args([list]), (entries: GameEntry[]) => deps.games.watch(entries));
}
