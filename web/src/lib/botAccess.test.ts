// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { botMarker, explicitNoBots, ghostNoBots } from "./botAccess";

const perChannel = { no_bots: false, bots_in_encrypted_channels: "per_channel", categories: [{ id: "cat", no_bots: false }] };
const allowed = { ...perChannel, bots_in_encrypted_channels: "allowed" };
const encrypted = { category_id: "cat", encrypted: true, no_bots: false, no_bots_effective: false, bots_allowed: false };

describe("ghost rule input (ENCRYPTION.md §4.6)", () => {
  it("closes encrypted channels of per_channel rooms even when the node says otherwise", () => {
    expect(ghostNoBots(encrypted, perChannel)).toBe(true);
    expect(ghostNoBots({ ...encrypted, bots_allowed: true }, perChannel)).toBe(false);
    expect(ghostNoBots(encrypted, allowed)).toBe(false);
    expect(ghostNoBots({ ...encrypted, encrypted: false }, perChannel)).toBe(false);
  });

  it("follows the node's flag and the explicit flags", () => {
    expect(ghostNoBots({ ...encrypted, no_bots_effective: true }, allowed)).toBe(true);
    expect(ghostNoBots({ ...encrypted, bots_allowed: true }, { ...perChannel, categories: [{ id: "cat", no_bots: true }] })).toBe(true);
    expect(ghostNoBots(undefined, perChannel)).toBe(false);
    expect(ghostNoBots({ ...encrypted, kind: "system", encrypted: false }, perChannel)).toBe(false);
  });
});

describe("channel list markers", () => {
  it("shows the no-bots icon only for explicit flags and the bots icon for allowed encrypted channels", () => {
    expect(botMarker(encrypted, perChannel)).toBeNull();
    expect(botMarker({ ...encrypted, bots_allowed: true }, perChannel)).toBe("bots_allowed");
    expect(botMarker({ ...encrypted, bots_allowed: true }, allowed)).toBeNull();
    expect(botMarker({ ...encrypted, no_bots: true, bots_allowed: true, no_bots_effective: true }, perChannel)).toBe("no_bots");
    expect(explicitNoBots(encrypted, { ...perChannel, no_bots: true })).toBe(true);
  });
});
