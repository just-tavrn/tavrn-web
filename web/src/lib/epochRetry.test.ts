// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { withFreshEpoch } from "./epochRetry";

const stale = () => new TavrnApiError({ type: "about:blank", title: "Conflict", status: 409, code: "mls.epoch_stale", detail: "moved on" } as never);

describe("withFreshEpoch (ENCRYPTION.md §5.3)", () => {
  it("catches up and encrypts again once when the node calls the epoch stale", async () => {
    const catchUp = vi.fn(async () => undefined);
    let n = 0;
    const attempt = vi.fn(async () => {
      if (n++ === 0) throw stale();
      return "sent";
    });
    await expect(withFreshEpoch({ catchUp }, "t.local/01J", attempt)).resolves.toBe("sent");
    expect(catchUp).toHaveBeenCalledWith("t.local/01J");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("passes other errors on and gives up after one retry", async () => {
    const catchUp = vi.fn(async () => undefined);
    await expect(withFreshEpoch({ catchUp }, "q", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(catchUp).not.toHaveBeenCalled();
    await expect(withFreshEpoch({ catchUp }, "q", async () => Promise.reject(stale()))).rejects.toMatchObject({ code: "mls.epoch_stale" });
    expect(catchUp).toHaveBeenCalledTimes(1);
  });

  it("does nothing special without a session manager (plaintext)", async () => {
    await expect(withFreshEpoch(null, "q", async () => 1)).resolves.toBe(1);
  });
});
