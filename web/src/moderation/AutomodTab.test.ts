// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { emptyDraft, fromDraft, toDraft } from "./AutomodTab";

describe("auto-moderation rule drafts", () => {
  it("turn the lists into lines and back, dropping blanks and unused fields", () => {
    const rule = { id: "01J00000000000000000000001", name: "Slurs", enabled: true, terms: ["bad", "spam*"], whole_word: true, links: "block_list", domains: ["evil.test"], exempt_roles: ["R"], exempt_channels: [], action: "timeout", timeout_minutes: 30 };
    const draft = toDraft(rule);
    expect(draft.terms).toBe("bad\nspam*");
    expect(draft.timeoutMinutes).toBe("30");
    expect(fromDraft(draft)).toEqual(rule);
    expect(fromDraft({ ...draft, terms: "  a \n\n b ", links: "off", action: "block" })).toMatchObject({ terms: ["a", "b"], domains: [], timeout_minutes: null });
    expect(fromDraft({ ...draft, id: null, timeoutMinutes: "x" })).not.toHaveProperty("id");
    expect(fromDraft({ ...draft, timeoutMinutes: "x" }).timeout_minutes).toBeNull();
  });

  it("start new rules as whole-word blocks", () => {
    expect(emptyDraft("Rule 2")).toMatchObject({ id: null, name: "Rule 2", wholeWord: true, action: "block", links: "off" });
  });
});
