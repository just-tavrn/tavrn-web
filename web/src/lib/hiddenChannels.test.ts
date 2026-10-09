// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { isRealDeletion, useHiddenChannels } from "./hiddenChannels";

describe("hidden channels", () => {
  beforeEach(() => useHiddenChannels.setState({ ids: {} }));

  it("remembers channels hidden from the user and forgets them when they come back or are deleted", () => {
    const s = () => useHiddenChannels.getState();
    s().deleted({ id: "c1", hidden: true });
    s().deleted({ id: "c2", hidden: true });
    expect(s().ids).toEqual({ c1: true, c2: true });
    s().created("c1");
    expect(s().ids).toEqual({ c2: true });
    s().deleted({ id: "c2" });
    expect(s().ids).toEqual({});
    s().deleted({});
    s().created(undefined);
    expect(s().ids).toEqual({});
  });

  it("only a deletion without the hidden flag is real", () => {
    expect(isRealDeletion({})).toBe(true);
    expect(isRealDeletion({ hidden: false })).toBe(true);
    expect(isRealDeletion({ hidden: true })).toBe(false);
  });
});
