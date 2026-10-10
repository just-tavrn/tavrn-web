// SPDX-License-Identifier: Apache-2.0
// Encrypted thread titles (PROTOCOL.md §7e): sealed bound to their thread where the id is known, and a title the node
// moved from another thread (signed context mismatch, ENCRYPTION.md §5.2) is shown like any unreadable title.
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Thread } from "@tavrn/sdk";

/** Keys this device holds per epoch (a shared history key adds one, ENCRYPTION.md §7b). */
const held = new Set([3]);
const mls = {
  encryptThreadTitle: vi.fn(async (_q: string, title: string, threadId?: string) => ({ title: `${title}|${threadId ?? "-"}`, title_epoch: 3 })),
  decryptThreadTitle: vi.fn(async (_q: string, t: { id: string; title: string; title_epoch: number }) =>
    !held.has(t.title_epoch)
      ? { ok: false as const, reason: "missing_key" as const }
      : t.title.endsWith(`|${t.id}`)
        ? { ok: true as const, title: t.title.split("|")[0]! }
        : { ok: false as const, reason: "envelope_mismatch" as const },
  ),
};
vi.mock("../stores/mls", async () => {
  const { create } = await import("zustand");
  return { getMls: async () => mls, useMlsUi: create<{ epochs: Record<string, number> }>(() => ({ epochs: {} })) };
});

import { useMlsUi } from "../stores/mls";
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

  it("decrypts again when the conversation's keys change: a forum title opens once its shared key arrives", async () => {
    const threads = [thread({ id: "T9", title: "Gap|T9", title_epoch: 5 })];
    const { result } = renderHook(() => useThreadTitles("n/G", threads));
    await waitFor(() => expect(mls.decryptThreadTitle).toHaveBeenCalledWith("n/G", threads[0]));
    await waitFor(() => expect(result.current.T9).toBeNull());
    // The key of epoch 5 is imported from a history share: the session manager bumps the conversation's epoch tick.
    held.add(5);
    act(() => useMlsUi.setState((s) => ({ epochs: { ...s.epochs, "n/G": (s.epochs["n/G"] ?? 0) + 1 } })));
    await waitFor(() => expect(result.current.T9).toBe("Gap"));
  });
});
