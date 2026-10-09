// SPDX-License-Identifier: Apache-2.0
// Encrypted thread titles (PROTOCOL.md §7e): sealed bound to their thread where the id is known, and a title the node
// moved from another thread (signed context mismatch, ENCRYPTION.md §5.2) is shown like any unreadable title.
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Thread } from "@tavrn/sdk";

const mls = {
  encryptThreadTitle: vi.fn(async (_q: string, title: string, threadId?: string) => ({ title: `${title}|${threadId ?? "-"}`, title_epoch: 3 })),
  decryptThreadTitle: vi.fn(async (_q: string, t: { id: string; title: string }) =>
    t.title.endsWith(`|${t.id}`) ? { ok: true as const, title: t.title.split("|")[0]! } : { ok: false as const, reason: "envelope_mismatch" as const },
  ),
};
vi.mock("../stores/mls", () => ({ getMls: async () => mls }));

import { sealTitle, useThreadTitles } from "./titles";

const thread = (over: Partial<Thread>) => ({ id: "T1", encrypted: true, title: "x", title_epoch: 3, title_author: "a@n", title_device_id: "D1", ...over }) as Thread;

describe("encrypted thread titles", () => {
  it("seals a title bound to its thread when the id is known, unbound otherwise", async () => {
    expect(await sealTitle("n/C", true, "Plan", null, "T1")).toEqual({ title: "Plan|T1", title_epoch: 3 });
    expect(await sealTitle("n/C", true, "Plan", null)).toEqual({ title: "Plan|-", title_epoch: 3 });
    expect(await sealTitle("n/C", false, " Plan ", null, "T1")).toEqual({ title: "Plan" });
  });

  it("shows a title only on its own thread: one moved to another thread reads as unreadable", async () => {
    const threads = [thread({ id: "T1", title: "Plan|T1" }), thread({ id: "T2", title: "Plan|T1" }), thread({ id: "T3", encrypted: false, title: "Open" })];
    const { result } = renderHook(() => useThreadTitles("n/C", threads));
    await waitFor(() => expect(result.current.T1).toBe("Plan"));
    expect(result.current.T2).toBeNull();
    expect(result.current.T3).toBe("Open");
  });
});
