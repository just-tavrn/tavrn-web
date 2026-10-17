// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { COMPOSER_PREFS_KEY, DEFAULT_COMPOSER_PREFS, parseComposerPrefs, useComposerPrefs } from "./composerPrefs";

afterEach(() => {
  useComposerPrefs.getState().set(DEFAULT_COMPOSER_PREFS);
  localStorage.clear();
});

describe("composer preferences", () => {
  it("default to a hidden formatting bar and the plain input; anything unknown falls back", () => {
    expect(DEFAULT_COMPOSER_PREFS).toEqual({ formatBar: false, styledInput: false });
    expect(parseComposerPrefs(null)).toEqual(DEFAULT_COMPOSER_PREFS);
    expect(parseComposerPrefs({ formatBar: "yes", styledInput: 1 })).toEqual(DEFAULT_COMPOSER_PREFS);
    expect(parseComposerPrefs({ formatBar: true, styledInput: true, other: "x" })).toEqual({ formatBar: true, styledInput: true });
  });

  it("are stored on this device and read again", () => {
    useComposerPrefs.getState().set({ styledInput: true });
    expect(JSON.parse(localStorage.getItem(COMPOSER_PREFS_KEY)!)).toEqual({ formatBar: false, styledInput: true });
    useComposerPrefs.setState({ styledInput: false });
    useComposerPrefs.getState().reload();
    expect(useComposerPrefs.getState().styledInput).toBe(true);
    localStorage.setItem(COMPOSER_PREFS_KEY, "{broken");
    useComposerPrefs.getState().reload();
    expect(useComposerPrefs.getState().styledInput).toBe(false);
  });
});
