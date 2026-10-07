// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { dismissVersion, dismissedVersion, shouldAsk } from "./TermsGate";

describe("terms dialog", () => {
  it("asks once per version in notice mode and always in require mode", () => {
    expect(shouldAsk({ pending: false, mode: "notice", current_version: 2 }, null)).toBe(false);
    expect(shouldAsk({ pending: true, mode: "notice", current_version: 2 }, null)).toBe(true);
    expect(shouldAsk({ pending: true, mode: "notice", current_version: 2 }, 2)).toBe(false);
    expect(shouldAsk({ pending: true, mode: "notice", current_version: 3 }, 2)).toBe(true);
    expect(shouldAsk({ pending: true, mode: "require", current_version: 2 }, 2)).toBe(true);
    expect(shouldAsk({ pending: true, mode: "notice", current_version: null }, null)).toBe(false);
    // During the sign-in setup only `require` interrupts.
    expect(shouldAsk({ pending: true, mode: "notice", current_version: 2 }, null, true)).toBe(false);
    expect(shouldAsk({ pending: true, mode: "require", current_version: 2 }, null, true)).toBe(true);
  });

  it("remembers a postponed version per account", () => {
    expect(dismissedVersion("a@t.local")).toBeNull();
    dismissVersion("a@t.local", 4);
    expect(dismissedVersion("a@t.local")).toBe(4);
    expect(dismissedVersion("b@t.local")).toBeNull();
  });
});
