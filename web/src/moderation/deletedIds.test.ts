// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { rememberDeleted, wasDeleted } from "./deletedIds";

describe("recently deleted messages", () => {
  it("are remembered, the oldest forgotten beyond the bound", () => {
    rememberDeleted("first");
    expect(wasDeleted("first")).toBe(true);
    expect(wasDeleted("other")).toBe(false);
    for (let i = 0; i < 500; i++) rememberDeleted(`m${i}`);
    expect(wasDeleted("first")).toBe(false);
    expect(wasDeleted("m499")).toBe(true);
  });
});
