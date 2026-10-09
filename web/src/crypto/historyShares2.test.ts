// SPDX-License-Identifier: Apache-2.0
// History shares v2 (ENCRYPTION.md §7b "Format v2"): the client seals shares per recipient device only where the node
// hosting the conversation announces `history.shares2`; the answer is cached, an unreachable node means format 1.
import { beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.fn();
vi.mock("../stores/nodes", async (original) => ({
  ...(await original<typeof import("../stores/nodes")>()),
  apiFor: () => ({ node: { info: () => info() } }),
}));

import { nodeHasShares2, resetHistory } from "./history";

beforeEach(() => {
  info.mockReset();
  resetHistory();
});

describe("nodeHasShares2", () => {
  it("reads the node's capabilities once per domain and caches them for ten minutes", async () => {
    info.mockResolvedValue({ capabilities: ["e2ee.mls1", "history.shares2"] });
    const now = Date.parse("2026-10-09T00:00:00.000Z");
    expect(await nodeHasShares2("a.test", now)).toBe(true);
    expect(await nodeHasShares2("a.test", now + 60_000)).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    await nodeHasShares2("a.test", now + 11 * 60_000);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("is false for nodes without the capability or that cannot be asked", async () => {
    info.mockResolvedValueOnce({ capabilities: ["e2ee.mls1"] });
    expect(await nodeHasShares2("old.test")).toBe(false);
    info.mockRejectedValueOnce(new Error("offline"));
    expect(await nodeHasShares2("down.test")).toBe(false);
  });
});
