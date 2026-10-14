// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { contentText } from "./local";

describe("contentText", () => {
  it("indexes text, embeds and the question and options of polls; nothing of other content", () => {
    expect(contentText({ type: "text", body: "Hallo", embeds: [{ title: "T", description: "D" }] })).toBe("Hallo\nT\nD");
    const poll = { type: "poll", kind: "choice", question: "Wohin?", options: [{ id: "a", label: "Küche" }, { id: "b", label: "Garten" }], max_choices: 1, results_visible: "always", votes_visible: "public" };
    expect(contentText(poll)).toBe("Wohin?\nKüche\nGarten");
    expect(contentText({ ...poll, kind: "date", slots: [{ id: "s1", start: "2026-11-06T19:00:00+01:00" }] })).toBe("Wohin?");
    expect(contentText({ type: "poll", question: "kaputt" })).toBeNull();
    expect(contentText({ type: "poll.vote", choices: ["a"] })).toBeNull();
  });
});
