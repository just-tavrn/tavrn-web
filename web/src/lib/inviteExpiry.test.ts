// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPIRY_HOURS, expiryChoices, inviteActive } from "./inviteExpiry";

describe("invite expiry", () => {
  it("offers never only with manage_room and at most 30 days otherwise", () => {
    expect(expiryChoices(false)).toEqual([1, 24, 168, 720]);
    expect(expiryChoices(true)).toContain(0);
    expect(Math.max(...expiryChoices(false))).toBe(720);
    expect(expiryChoices(false)).toContain(DEFAULT_EXPIRY_HOURS);
  });

  it("knows active invites", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    expect(inviteActive({ expires_at: null, max_uses: 0, uses: 99 }, now)).toBe(true);
    expect(inviteActive({ expires_at: "2026-10-06T11:59:59Z", max_uses: 0, uses: 0 }, now)).toBe(false);
    expect(inviteActive({ expires_at: "2026-10-07T00:00:00Z", max_uses: 2, uses: 2 }, now)).toBe(false);
    expect(inviteActive({ expires_at: "2026-10-07T00:00:00Z", max_uses: 2, uses: 1 }, now)).toBe(true);
  });
});
