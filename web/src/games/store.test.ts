// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { KNOWN_GAMES } from "./known";
import { MAX_OWN, parseGames, useGames, validEntry, watchList } from "./store";

beforeEach(() => {
  localStorage.clear();
  useGames.setState(parseGames(null));
});

describe("the game activity setting", () => {
  it("is off by default and watches nothing then", () => {
    expect(useGames.getState().enabled).toBe(false);
    expect(watchList(useGames.getState())).toEqual([]);
  });

  it("watches the built-in list without the entries switched off, plus the own ones, and keeps it on this device", () => {
    const g = useGames.getState();
    g.setEnabled(true);
    g.setKnown("eldenring.exe", false);
    expect(useGames.getState().addOwn({ process: " mygame.x86_64 ", name: " My Game " })).toBe(true);
    const list = watchList(useGames.getState());
    expect(list).toHaveLength(KNOWN_GAMES.length);
    expect(list.some((e) => e.process === "eldenring.exe")).toBe(false);
    expect(list.at(-1)).toEqual({ process: "mygame.x86_64", name: "My Game" });
    expect(parseGames(JSON.parse(localStorage.getItem("tavrn.games") ?? "null"))).toEqual({ enabled: true, off: ["eldenring.exe"], own: [{ process: "mygame.x86_64", name: "My Game" }] });
    useGames.getState().setKnown("ELDENRING.EXE", true);
    useGames.getState().removeOwn("MYGAME.x86_64");
    expect(watchList(useGames.getState())).toHaveLength(KNOWN_GAMES.length);
  });

  it("refuses paths, empty and overlong entries, and more than the limit", () => {
    for (const bad of [{ process: "C:\\Games\\x.exe", name: "X" }, { process: "/usr/bin/x", name: "X" }, { process: "x", name: "" }, { process: "a".repeat(65), name: "X" }, { process: "x", name: "n".repeat(129) }]) {
      expect(validEntry(bad), JSON.stringify(bad)).toBe(false);
      expect(useGames.getState().addOwn(bad)).toBe(false);
    }
    for (let i = 0; i < MAX_OWN; i++) useGames.getState().addOwn({ process: `g${i}`, name: "G" });
    expect(useGames.getState().addOwn({ process: "one-more", name: "G" })).toBe(false);
    expect(parseGames({ enabled: "yes", own: [{ process: "/x", name: "X" }, 3], off: [1, "cs2"] })).toEqual({ enabled: false, off: ["cs2"], own: [] });
  });

  it("built-in entries are valid and unique", () => {
    expect(KNOWN_GAMES.every(validEntry)).toBe(true);
    expect(new Set(KNOWN_GAMES.map((g) => g.process.toLowerCase())).size).toBe(KNOWN_GAMES.length);
  });
});
