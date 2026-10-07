// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ACCESSIBILITY, parseAccessibility, useAccessibility } from "./accessibility";

describe("accessibility settings", () => {
  beforeEach(() => localStorage.clear());

  it("falls back to the defaults for missing or invalid values", () => {
    expect(parseAccessibility(null)).toEqual(DEFAULT_ACCESSIBILITY);
    expect(parseAccessibility({ announceMessages: "yes" })).toEqual(DEFAULT_ACCESSIBILITY);
    expect(parseAccessibility({ announceMessages: false })).toEqual({ announceMessages: false });
  });

  it("stores a change on this device", () => {
    useAccessibility.getState().set({ announceMessages: false });
    expect(useAccessibility.getState().announceMessages).toBe(false);
    expect(JSON.parse(localStorage.getItem("tavrn.accessibility")!)).toEqual({ announceMessages: false });
    useAccessibility.getState().set({ announceMessages: true });
  });
});
