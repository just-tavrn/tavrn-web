// SPDX-License-Identifier: Apache-2.0
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useNotifications } from "../stores/notifications";
import { useThreads } from "./store";
import { useThreadMarkRead } from "./useThreadMarkRead";

beforeEach(() => {
  vi.useFakeTimers();
  useNotifications.getState().reset();
  useThreads.setState({ followed: {}, open: null });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(api.threads, "markRead").mockResolvedValue({ thread_id: "t1", channel_id: "c1", room_id: "r1", following: false, last_read_message_id: "01", unread_count: 0, mention_count: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("acknowledges a direct mention even when the thread is not followed", () => {
  useNotifications.getState().push({ kind: "mention", title: "Mention", body: "", path: "/rooms/r1/channels/c1/threads/t1", messageId: "01" });
  const { unmount } = renderHook(() => useThreadMarkRead("t1", "01"));
  expect(useNotifications.getState().entries[0]?.read).toBe(true);
  unmount();
});

it("leaves later background messages unseen until focus returns", () => {
  const { rerender, unmount } = renderHook(({ id }) => useThreadMarkRead("t1", id), { initialProps: { id: "01" } });
  vi.mocked(document.hasFocus).mockReturnValue(false);
  useNotifications.getState().push({ kind: "mention", title: "Mention", body: "", path: "/rooms/r1/channels/c1/threads/t1", messageId: "02" });
  rerender({ id: "02" });
  expect(useNotifications.getState().entries[0]?.read).toBe(false);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(useNotifications.getState().entries[0]?.read).toBe(true);
  unmount();
});
