// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { showUnverified } from "./unverified";

const plain = { encrypted: false, device_id: "01JDEVICE", author_kind: "user" as const };

describe("showUnverified: the small marker on plaintext messages (FEDERATION.md §10.3)", () => {
  it("marks unsigned and uncheckable messages of people", () => {
    expect(showUnverified(plain, "unsigned", false)).toBe(true);
    expect(showUnverified(plain, "unverifiable", false)).toBe(true);
  });

  it("leaves valid, unchecked, hidden, encrypted, system and webhook messages alone", () => {
    expect(showUnverified(plain, "valid", false)).toBe(false);
    expect(showUnverified(plain, undefined, false)).toBe(false);
    expect(showUnverified(plain, "invalid", false)).toBe(false);
    expect(showUnverified({ ...plain, encrypted: true }, "unsigned", false)).toBe(false);
    expect(showUnverified({ ...plain, device_id: null }, "unsigned", false)).toBe(false);
    expect(showUnverified({ ...plain, author_kind: "webhook" }, "unsigned", false)).toBe(false);
  });

  it("does not mark unsigned plaintext of a bot: the node authenticated its app token and the BOT badge says where it comes from", () => {
    expect(showUnverified({ ...plain, author_kind: "bot" }, "unsigned", true)).toBe(false);
    // A bot known from the member list, whatever the envelope says.
    expect(showUnverified(plain, "unsigned", true)).toBe(false);
    // A signature that cannot be checked is the same doubt as for a person.
    expect(showUnverified({ ...plain, author_kind: "bot" }, "unverifiable", true)).toBe(true);
  });
});
