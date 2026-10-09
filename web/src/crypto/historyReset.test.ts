// SPDX-License-Identifier: Apache-2.0
// The client's reset rule (ENCRYPTION.md §7b "History after a key reset"): the recipient's identity reset comes from
// its home node's keys document, cached, so that even an older node cannot make this client share the old range.
import { beforeEach, describe, expect, it, vi } from "vitest";

const homeKeys = vi.fn();
vi.mock("../stores/nodes", async (original) => ({ ...(await original<typeof import("../stores/nodes")>()), homeKeys: (a: string) => homeKeys(a) }));

import { identityResetAt, resetHistory } from "./history";

beforeEach(() => {
  homeKeys.mockReset();
  resetHistory();
});

describe("identityResetAt", () => {
  it("reads identity_reset_at once per address and caches it for five minutes", async () => {
    homeKeys.mockResolvedValue({ user: "bob@t.local", identity_reset_at: "2026-10-08T10:00:00.000Z", devices: [] });
    const now = Date.parse("2026-10-09T00:00:00.000Z");
    expect(await identityResetAt("bob@t.local", now)).toBe(Date.parse("2026-10-08T10:00:00.000Z"));
    expect(await identityResetAt("bob@t.local", now + 60_000)).toBe(Date.parse("2026-10-08T10:00:00.000Z"));
    expect(homeKeys).toHaveBeenCalledTimes(1);
    await identityResetAt("bob@t.local", now + 6 * 60_000);
    expect(homeKeys).toHaveBeenCalledTimes(2);
  });

  it("is null without a reset or when the home node cannot be asked", async () => {
    homeKeys.mockResolvedValueOnce({ user: "carol@t.local", identity_reset_at: null, devices: [] });
    expect(await identityResetAt("carol@t.local")).toBeNull();
    homeKeys.mockRejectedValueOnce(new Error("offline"));
    expect(await identityResetAt("dave@t.local")).toBeNull();
  });
});
