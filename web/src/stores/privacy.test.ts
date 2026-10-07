// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePrivacy } from "./privacy";

describe("privacy store", () => {
  beforeEach(() => {
    localStorage.clear();
    usePrivacy.setState({ autoPreview: "friends_and_shared", maxBytes: 5 * 1024 * 1024, friends: new Set() });
  });

  it("takes only valid values from the node and mirrors them locally", () => {
    usePrivacy.getState().hydrate("never");
    expect(usePrivacy.getState().autoPreview).toBe("never");
    expect(localStorage.getItem("tavrn.privacy.auto_preview")).toBe("never");
    usePrivacy.getState().hydrate("sometimes");
    usePrivacy.getState().hydrate(undefined);
    expect(usePrivacy.getState().autoPreview).toBe("never");
  });

  it("saves optimistically and reverts when the node refuses", async () => {
    const put = vi.fn().mockResolvedValue({});
    await usePrivacy.getState().save("always", put);
    expect(put).toHaveBeenCalledWith("always");
    expect(usePrivacy.getState().autoPreview).toBe("always");
    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(usePrivacy.getState().save("never", failing)).rejects.toThrow("offline");
    expect(usePrivacy.getState().autoPreview).toBe("always");
    expect(localStorage.getItem("tavrn.privacy.auto_preview")).toBe("always");
  });

  it("accepts only sensible caps and keeps the friends set stable when nothing changed", () => {
    usePrivacy.getState().setMaxBytes(1024);
    usePrivacy.getState().setMaxBytes(-1);
    usePrivacy.getState().setMaxBytes("big");
    expect(usePrivacy.getState().maxBytes).toBe(1024);
    usePrivacy.getState().setFriends(["a@x", "b@x"]);
    const first = usePrivacy.getState().friends;
    usePrivacy.getState().setFriends(["b@x", "a@x"]);
    expect(usePrivacy.getState().friends).toBe(first);
    usePrivacy.getState().setFriends(["a@x"]);
    expect([...usePrivacy.getState().friends]).toEqual(["a@x"]);
  });
});
