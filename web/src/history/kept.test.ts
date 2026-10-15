// SPDX-License-Identifier: Apache-2.0
// "Keep the full history" is decided from the loaded index state: asking the index (`coverage`) writes its pending
// buffer, which the message list did on every change of its messages, defeating the batching of the indexer.
import { beforeEach, describe, expect, it, vi } from "vitest";

const coverage = vi.hoisted(() => vi.fn(async (_q?: string) => [] as Array<{ complete: boolean }>));

vi.mock("../search/local", async (orig) => ({
  ...(await orig<typeof import("../search/local")>()),
  localIndex: async () => ({ coverage }),
}));

import { useLocalSearch } from "../search/local";
import { keptInIndex } from "./local";

describe("keptInIndex", () => {
  beforeEach(() => {
    coverage.mockClear();
    useLocalSearch.setState({ coverage: {}, stats: null, ready: false });
  });

  it("does not touch the index once its state is loaded", async () => {
    useLocalSearch.setState({ ready: true, stats: { bytes: 1, conversations: 1, messages: 1, complete: 1 }, coverage: { "n.test/K": { conversation: "n.test/K", complete: true } as never } });
    for (let i = 0; i < 10; i++) {
      expect(await keptInIndex("n.test/K")).toBe(true);
      expect(await keptInIndex("n.test/OTHER")).toBe(false);
    }
    expect(coverage).not.toHaveBeenCalled();
  });

  it("asks the index right after a start, before its state is loaded", async () => {
    coverage.mockResolvedValueOnce([{ complete: true }]);
    expect(await keptInIndex("n.test/K")).toBe(true);
    expect(coverage).toHaveBeenCalledWith("n.test/K");
  });
});
