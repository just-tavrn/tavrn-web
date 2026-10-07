// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { useNode } from "../components/NodeScope";
import { useUnread } from "../stores/unread";

/** Delay before the read marker is sent, so a burst of messages costs one request. */
export const MARK_READ_DELAY_MS = 500;

/** Is the user looking at this tab? */
export function isAttentive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Marks the open conversation read up to `newestId` (design note 4.4): once when it is opened, later
 * for new messages only while the tab is visible and focused (and again when focus returns). The
 * local counts clear at once; the marker goes to the node debounced (`PUT …/read`), a pending one is
 * sent when the conversation closes.
 */
export function useMarkRead(conversationId: string, newestId: string | undefined) {
  const newest = useRef(newestId);
  newest.current = newestId;
  const check = useRef<() => void>(() => undefined);
  // Read markers go to the node of the conversation.
  const { api } = useNode();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    // No conversation (a thread view marks its thread instead, threads/useThreadMarkRead).
    if (!conversationId) return;
    let opened = false;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const id = pending;
      pending = null;
      if (id) apiRef.current.conversations.markRead(conversationId, id).catch(() => undefined);
    };
    check.current = () => {
      const id = newest.current;
      if (!id || (opened && !isAttentive())) return;
      // Marked unread by hand (design note 4.11): stays unread while the user is here.
      if (useUnread.getState().held[conversationId]) return;
      opened = true;
      const s = useUnread.getState().states[conversationId];
      if (s?.read && s.read >= id && s.unread === 0) return;
      useUnread.getState().read(conversationId, id);
      pending = id;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, MARK_READ_DELAY_MS);
    };
    const onAttention = () => check.current();
    window.addEventListener("focus", onAttention);
    document.addEventListener("visibilitychange", onAttention);
    return () => {
      window.removeEventListener("focus", onAttention);
      document.removeEventListener("visibilitychange", onAttention);
      check.current = () => undefined;
      flush();
      useUnread.getState().release(conversationId);
    };
  }, [conversationId]);

  useEffect(() => {
    check.current();
  }, [conversationId, newestId]);
}
