// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DRAFTS, clearDraft, clearDrafts, draftCount, draftGeneration, draftKey, getDraft, saveDraftReply, saveDraftText, useDraftReply } from "./drafts";

afterEach(() => clearDrafts());

describe("draft memory", () => {
  it("keys drafts by account, node, conversation and thread", () => {
    const channel = draftKey("Alice@Home.Test", "home.test", "C1");
    const thread = draftKey("alice@home.test", "home.test", "C1", "T1");
    const other = draftKey("alice@home.test", "far.test", "C1");
    expect(channel).toBe(draftKey("alice@home.test", "HOME.test", "C1"));
    expect(new Set([channel, thread, other, draftKey("bob@home.test", "home.test", "C1")]).size).toBe(4);
    expect(draftKey(null, "home.test", "C1")).toBeNull();
  });

  it("keeps text and reply, drops empty drafts and clears one after sending", () => {
    const k = draftKey("a@h", "h", "C1")!;
    saveDraftText(k, "hallo");
    saveDraftReply(k, { id: "M1" });
    expect(getDraft(k)).toEqual({ text: "hallo", reply: { id: "M1" } });
    saveDraftText(k, "");
    expect(getDraft(k)).toEqual({ text: "", reply: { id: "M1" } });
    saveDraftReply(k, null);
    expect(getDraft(k)).toBeUndefined();
    saveDraftText(k, "wieder");
    clearDraft(k);
    expect(getDraft(k)).toBeUndefined();
  });

  it("clearing all drafts bumps the generation: writes of a composer from before are ignored", () => {
    const k = draftKey("a@h", "h", "C1")!;
    const gen = draftGeneration();
    saveDraftText(k, "geheim", gen);
    clearDrafts();
    expect(draftCount()).toBe(0);
    // A composer that was open during the sign-out writes back on unmount: refused.
    saveDraftText(k, "geheim", gen);
    expect(getDraft(k)).toBeUndefined();
  });

  it("is bounded: the least recently written draft goes first", () => {
    for (let i = 0; i <= MAX_DRAFTS; i++) saveDraftText(`k${i}`, "x");
    expect(draftCount()).toBe(MAX_DRAFTS);
    expect(getDraft("k0")).toBeUndefined();
    expect(getDraft(`k${MAX_DRAFTS}`)).toBeDefined();
  });

  it("uses no browser storage", () => {
    localStorage.clear();
    sessionStorage.clear();
    saveDraftText("k", "nur im Speicher");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("the reply target of a draft", () => {
  it("is kept with the conversation's draft and restored when it is opened again", () => {
    const k = draftKey("a@h", "h", "C1")!;
    const first = renderHook(() => useDraftReply<{ id: string }>(k));
    act(() => first.result.current[1]({ id: "M1" }));
    first.unmount();
    const again = renderHook(() => useDraftReply<{ id: string }>(k));
    expect(again.result.current[0]).toEqual({ id: "M1" });
    // Another conversation has none; cancelling (or sending) drops it.
    expect(renderHook(() => useDraftReply(draftKey("a@h", "h", "C2"))).result.current[0]).toBeNull();
    act(() => again.result.current[1](null));
    expect(getDraft(k)).toBeUndefined();
  });
});
