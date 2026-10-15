// SPDX-License-Identifier: Apache-2.0
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";
import type { Decrypted, MlsManager, PlainStatus } from "@tavrn/e2ee";

const archived = vi.hoisted(() => ({ calls: [] as string[][], store: new Map<string, { ok: true; content: Record<string, unknown> }>() }));
vi.mock("../history/local", () => ({
  archivedDecrypted: async (_q: string, messages: Message[]) => {
    archived.calls.push(messages.map((m) => m.id));
    // Fresh objects on every read, as the archive returns them.
    const out = new Map<string, Decrypted>();
    for (const m of messages) {
      const d = archived.store.get(m.id);
      if (d) out.set(m.id, { ...d, content: { ...d.content } });
    }
    return out;
  },
}));

import { RETRY_NON_FINAL_MS, useDecrypted, usePlainSignatures } from "./useE2eeConversation";

const enc = (id: string, content = `ct-${id}`): Message => ({ id, encrypted: true, content, device_id: "d1", author: "a@t", epoch: 1 }) as unknown as Message;
const plain = (id: string, text = id): Message => ({ id, encrypted: false, content: { text }, device_id: "d1", author: "a@t", signature: `sig-${id}` }) as unknown as Message;

function fakeMls(): MlsManager & { decryptCalls: string[]; verifyCalls: string[] } {
  const decryptCalls: string[] = [];
  const verifyCalls: string[] = [];
  return {
    decryptCalls,
    verifyCalls,
    decrypt: vi.fn(async (_q: string, m: Message): Promise<Decrypted> => {
      decryptCalls.push(m.id);
      return { ok: true, content: { text: `plain ${String(m.content)}` } };
    }),
    verifyPlaintext: vi.fn(async (_q: string, m: Message): Promise<PlainStatus> => {
      verifyCalls.push(m.id);
      return "valid";
    }),
  } as unknown as MlsManager & { decryptCalls: string[]; verifyCalls: string[] };
}

describe("useDecrypted", () => {
  beforeEach(() => {
    archived.calls = [];
    archived.store.clear();
  });

  it("decrypts only new or changed messages and keeps the results of the others", async () => {
    const mls = fakeMls();
    const first = Array.from({ length: 100 }, (_, i) => enc(`m${String(i).padStart(3, "0")}`));
    const { result, rerender } = renderHook(({ messages, tick }) => useDecrypted("n/c", messages, mls, tick), { initialProps: { messages: first, tick: 0 } });
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(100));
    expect(mls.decryptCalls).toHaveLength(100);
    const before = result.current;

    // One new message: one archive read of one message, one decrypt; every other result keeps its identity.
    const next = [...first, enc("m100")];
    rerender({ messages: next, tick: 0 });
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(101));
    expect(mls.decryptCalls).toHaveLength(101);
    expect(archived.calls.at(-1)).toEqual(["m100"]);
    for (const m of first) expect(result.current[m.id]).toBe(before[m.id]);

    // An edit (new ciphertext under the same id) is decrypted again.
    const edited = next.map((m) => (m.id === "m005" ? enc("m005", "ct-edited") : m));
    rerender({ messages: edited, tick: 0 });
    await waitFor(() => expect(result.current.m005).toMatchObject({ ok: true, content: { text: "plain ct-edited" } }));
    expect(mls.decryptCalls.filter((id) => id === "m005")).toHaveLength(2);
    expect(mls.decryptCalls).toHaveLength(102);
  });

  it("keeps the identity of archived results instead of reading them again", async () => {
    const mls = fakeMls();
    const first = Array.from({ length: 50 }, (_, i) => enc(`m${String(i).padStart(3, "0")}`));
    for (const m of first) archived.store.set(m.id, { ok: true, content: { text: `archived ${m.id}` } });
    const { result, rerender } = renderHook(({ messages }) => useDecrypted("n/c", messages, mls, 0), { initialProps: { messages: first } });
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(50));
    const before = result.current;
    expect(mls.decryptCalls).toHaveLength(0);
    // A reaction replaces one message object without changing its content: nothing is read or decrypted again.
    const reacted = first.map((m) => (m.id === "m010" ? ({ ...m, reactions: [{ emoji: "x", count: 1 }] } as unknown as Message) : m));
    rerender({ messages: [...reacted, enc("m050")] });
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(51));
    expect(archived.calls.at(-1)).toEqual(["m010", "m050"]);
    for (const m of first) expect(result.current[m.id]).toBe(before[m.id]);
  });

  it("tries messages without a key again when the group changes", async () => {
    const mls = fakeMls();
    let missing = true;
    (mls.decrypt as ReturnType<typeof vi.fn>).mockImplementation(async (_q: string, m: Message): Promise<Decrypted> => {
      mls.decryptCalls.push(m.id);
      return m.id === "m1" && missing ? { ok: false, reason: "missing_key" } : { ok: true, content: { text: m.id } };
    });
    const messages = [enc("m0"), enc("m1")];
    const { result, rerender } = renderHook(({ tick }) => useDecrypted("n/c", messages, mls, tick), { initialProps: { tick: 0 } });
    await waitFor(() => expect(result.current.m1).toEqual({ ok: false, reason: "missing_key" }));
    const m0 = result.current.m0;
    missing = false;
    rerender({ tick: 1 });
    await waitFor(() => expect(result.current.m1).toMatchObject({ ok: true }));
    expect(result.current.m0).toBe(m0);
    expect(mls.decryptCalls).toEqual(["m0", "m1", "m1"]);
  });

  it("tries a message again on its own when the sender's devices could not be looked up (reason retry, #175)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const mls = fakeMls();
      let lookups = 0;
      (mls.decrypt as ReturnType<typeof vi.fn>).mockImplementation(async (_q: string, m: Message): Promise<Decrypted> => {
        mls.decryptCalls.push(m.id);
        if (m.id !== "m1") return { ok: true, content: { text: m.id } };
        // The first two lookups fail for the moment, the third one works.
        return ++lookups < 3 ? { ok: false, reason: "retry" } : { ok: true, content: { text: m.id } };
      });
      const messages = [enc("m0"), enc("m1")];
      const { result } = renderHook(() => useDecrypted("n/c", messages, mls, 0));
      await vi.waitFor(() => expect(result.current.m1).toEqual({ ok: false, reason: "retry" }));
      const m0 = result.current.m0;
      // No group change and no new message: the timer alone decrypts it again, as often as needed.
      await act(() => vi.advanceTimersByTimeAsync(RETRY_NON_FINAL_MS));
      await vi.waitFor(() => expect(lookups).toBe(2));
      expect(result.current.m1).toEqual({ ok: false, reason: "retry" });
      await act(() => vi.advanceTimersByTimeAsync(RETRY_NON_FINAL_MS));
      await vi.waitFor(() => expect(result.current.m1).toMatchObject({ ok: true }));
      expect(result.current.m0).toBe(m0);
      expect(mls.decryptCalls).toEqual(["m0", "m1", "m1", "m1"]);
      // Settled: no timer is left that would decrypt again.
      await act(() => vi.advanceTimersByTimeAsync(3 * RETRY_NON_FINAL_MS));
      expect(mls.decryptCalls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("usePlainSignatures", () => {
  it("checks only new or changed plaintext messages", async () => {
    const mls = fakeMls();
    const first = Array.from({ length: 40 }, (_, i) => plain(`p${String(i).padStart(3, "0")}`));
    const { result, rerender } = renderHook(({ messages }) => usePlainSignatures("n/c", messages, mls, 0), { initialProps: { messages: first } });
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(40));
    expect(mls.verifyCalls).toHaveLength(40);
    rerender({ messages: [...first, plain("p040")] });
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(41));
    expect(mls.verifyCalls).toHaveLength(41);
    // A changed envelope (new object) is checked again.
    rerender({ messages: [...first.slice(1), plain("p000", "changed"), plain("p040")] });
    await waitFor(() => expect(mls.verifyCalls).toHaveLength(42));
  });
});
