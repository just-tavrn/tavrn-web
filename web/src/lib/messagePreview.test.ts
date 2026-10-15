// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { previewText } from "./messagePreview";

describe("previewText", () => {
  it("one line of a text, cut with an ellipsis", () => {
    expect(previewText({ type: "text", body: "  Hallo\n\nGilde  " }, 100)).toBe("Hallo Gilde");
    const long = previewText({ type: "text", body: "x".repeat(300) }, 140)!;
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });

  it("a poll reads as its question; content without text has no preview", () => {
    expect(previewText({ type: "poll", kind: "choice", question: "Wohin\ngehen wir?" }, 140)).toBe("📊 Wohin gehen wir?");
    expect(previewText({ type: "poll", question: "q".repeat(200) }, 100)!.length).toBe(100);
    expect(previewText({ type: "attachment" }, 100)).toBeNull();
    expect(previewText(null, 100)).toBeNull();
  });
});
