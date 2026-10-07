// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { RECENT_MAX, buildEmojiData, loadEmojiData, normalizeEmoji, recentEmojis, rememberEmoji, searchEmojis, setSkinTone, skinTone, withTone } from "./emojiData";

describe("emoji data (design note 4.13)", () => {
  it("loads English and German names and keywords, without skin tone components", async () => {
    const de = await loadEmojiData("de");
    const thumbs = de.entries.find((e) => e.unicode === "👍")!;
    expect(thumbs.label).toBe("Daumen hoch");
    expect(thumbs.names).toEqual(["thumbs up", "daumen hoch"]);
    expect(thumbs.terms).toEqual(expect.arrayContaining(["+1", "daumen", "like"]));
    expect(thumbs.skins).toHaveLength(5);
    expect(de.groups[2]).toHaveLength(0);
    expect(de.entries.length).toBeGreaterThan(1500);
    const en = await loadEmojiData("en");
    expect(en.entries.find((e) => e.unicode === "👍")!.label).toBe("thumbs up");
  });

  it("searches names and keywords in both languages, best matches first", async () => {
    const data = await loadEmojiData("de");
    expect(searchEmojis(data, "daumen")[0]?.unicode).toBe("👍");
    expect(searchEmojis(data, "thumbs").map((e) => e.unicode)).toContain("👍");
    expect(searchEmojis(data, "Herz").length).toBeGreaterThan(5);
    expect(searchEmojis(data, "fire")[0]?.unicode).toBe("🔥");
    expect(searchEmojis(data, "")).toEqual([]);
    expect(searchEmojis(data, "zzzzqqq")).toEqual([]);
    // Diacritics are ignored: "lacheln" finds "lächeln".
    expect(searchEmojis(data, "lacheln").length).toBeGreaterThan(0);
  });

  it("applies skin tones and normalizes variation selectors like the quick reactions", () => {
    const data = buildEmojiData([
      { hexcode: "1F44D", label: "thumbs up", unicode: "👍️", group: 1, order: 1, tags: ["yes"], skins: ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"].map((t) => ({ hexcode: `1F44D-${t}`, label: "x", unicode: `👍${String.fromCodePoint(parseInt(t, 16))}` })) },
      { hexcode: "2764", label: "red heart", unicode: "❤️", group: 8, order: 2 },
      { hexcode: "1F3FB", label: "light skin tone", unicode: "🏻", group: 2, order: 3 },
    ]);
    expect(data.entries.map((e) => e.unicode)).toEqual(["👍", "❤️"]);
    expect(withTone(data.entries[0]!, 0)).toBe("👍");
    expect(withTone(data.entries[0]!, 3)).toBe("👍🏽");
    expect(withTone(data.entries[1]!, 3)).toBe("❤️");
    expect(normalizeEmoji("👍️")).toBe("👍");
    expect(normalizeEmoji("☺️")).toBe("☺️");
  });
});

describe("recently used and skin tone (local storage)", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the newest first without duplicates, bounded", () => {
    rememberEmoji("👍");
    rememberEmoji("🔥");
    rememberEmoji("👍");
    expect(recentEmojis()).toEqual(["👍", "🔥"]);
    for (let i = 0; i < RECENT_MAX + 5; i++) rememberEmoji(`:e${i}:`);
    expect(recentEmojis()).toHaveLength(RECENT_MAX);
  });

  it("survives broken or unavailable storage", () => {
    localStorage.setItem("tavrn.emoji.recent", "{not json");
    expect(recentEmojis()).toEqual([]);
    localStorage.setItem("tavrn.emoji.tone", "9");
    expect(skinTone()).toBe(0);
    setSkinTone(4);
    expect(skinTone()).toBe(4);
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(recentEmojis()).toEqual([]);
      expect(skinTone()).toBe(0);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
