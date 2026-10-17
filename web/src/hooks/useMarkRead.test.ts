// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useUnread } from "../stores/unread";
import { useNotifications } from "../stores/notifications";
import { MARK_READ_DELAY_MS, useMarkRead } from "./useMarkRead";

describe("useMarkRead", () => {
  let focused = true;
  beforeEach(() => {
    vi.useFakeTimers();
    useNotifications.getState().reset();
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    useUnread.setState({ states: { c1: { last: "05", read: "02", unread: 3, mentions: 1 } } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears at once, sends one debounced marker per burst and the pending one on close", async () => {
    const markRead = vi.spyOn(api.conversations, "markRead").mockResolvedValue({ conversation_id: "c1", unread_count: 0, mention_count: 0 });
    const { rerender, unmount } = renderHook(({ id }) => useMarkRead("c1", id), { initialProps: { id: "05" as string | undefined } });
    expect(useUnread.getState().states.c1).toMatchObject({ read: "05", unread: 0, mentions: 0 });
    rerender({ id: "06" });
    rerender({ id: "07" });
    expect(markRead).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS));
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenLastCalledWith("c1", "07");
    rerender({ id: "08" });
    unmount();
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenLastCalledWith("c1", "08");
  });

  it("acknowledges saved entries even if the local conversation marker is already current", () => {
    useUnread.setState({ states: { c1: { last: "05", read: "05", unread: 0, mentions: 0 } } });
    useNotifications.getState().push({ kind: "dm", title: "Message", body: "", path: "/conversations/c1", messageId: "05" });
    const { unmount } = renderHook(() => useMarkRead("c1", "05"));
    expect(useNotifications.getState().entries[0]?.read).toBe(true);
    unmount();
  });

  it("marks on opening even without focus, later only with focus", async () => {
    const markRead = vi.spyOn(api.conversations, "markRead").mockResolvedValue({ conversation_id: "c1", unread_count: 0, mention_count: 0 });
    focused = false;
    const { rerender } = renderHook(({ id }) => useMarkRead("c1", id), { initialProps: { id: "05" } });
    await act(() => vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS));
    expect(markRead).toHaveBeenCalledWith("c1", "05");
    useUnread.getState().message({ id: "06", conversation_id: "c1", author_id: "u2", mentions: [], mentions_everyone: false }, { id: "u1", address: "a@t" }, false);
    rerender({ id: "06" });
    await act(() => vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS));
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(useUnread.getState().states.c1?.unread).toBe(1);
    focused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(() => vi.advanceTimersByTimeAsync(MARK_READ_DELAY_MS));
    expect(markRead).toHaveBeenLastCalledWith("c1", "06");
    expect(useUnread.getState().states.c1?.unread).toBe(0);
  });
});
