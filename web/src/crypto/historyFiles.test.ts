// SPDX-License-Identifier: Apache-2.0
// Files channels in the history key checks (FILES.md §8.7, ENCRYPTION.md §7b): entry records stand in for messages,
// by epoch and from a time on; a backwards query cannot be answered and must not look like "nothing before".
import { describe, expect, it, vi } from "vitest";
import { newUlid, type TavrnApi } from "@tavrn/sdk";
import { fileRecordSamples } from "./history";

const entry = (epoch: number) => ({ id: `e${epoch}`, record: "ct", record_author: "alice@t.local", record_device_id: "d1", record_epoch: epoch });

function api(entries: unknown[]) {
  const records = vi.fn().mockResolvedValue({ entries });
  return { a: { files: { records } } as unknown as TavrnApi, records };
}

describe("fileRecordSamples", () => {
  it("lists the records of one epoch as key samples", async () => {
    const { a, records } = api([entry(4)]);
    const out = await fileRecordSamples(a, "room1", "chan1", { epoch: 4, limit: 10 });
    expect(records).toHaveBeenCalledWith("room1", "chan1", { epoch: 4, since: undefined, limit: 10 });
    expect(out).toEqual([{ author: "alice@t.local", device_id: "d1", epoch: 4, content: "ct", encrypted: true }]);
  });

  it("turns a ULID floor into the records' since time (the reset-aware window)", async () => {
    const { a, records } = api([entry(7), entry(8)]);
    const at = Date.parse("2026-10-08T10:00:00.000Z");
    const out = await fileRecordSamples(a, "room1", "chan1", { after: newUlid(at, (b) => b.fill(0)), limit: 20 });
    expect(records).toHaveBeenCalledWith("room1", "chan1", { epoch: undefined, since: "2026-10-08T10:00:00.000Z", limit: 20 });
    expect(out.map((m) => m.epoch)).toEqual([7, 8]);
  });

  it("refuses a backwards query instead of answering 'nothing before'", async () => {
    const { a, records } = api([entry(1)]);
    await expect(fileRecordSamples(a, "room1", "chan1", { before: "01J0000000000000000000000", limit: 1 })).rejects.toThrow();
    expect(records).not.toHaveBeenCalled();
  });

  it("asks nothing without an epoch or a start", async () => {
    const { a, records } = api([entry(1)]);
    expect(await fileRecordSamples(a, "room1", "chan1", { limit: 5 })).toEqual([]);
    expect(records).not.toHaveBeenCalled();
  });
});
