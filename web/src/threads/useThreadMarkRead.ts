// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { useNode } from "../components/NodeScope";
import { isAttentive, MARK_READ_DELAY_MS } from "../hooks/useMarkRead";
import { useThreads } from "./store";
import { applyThreadState } from "./realtime";
import { useUnread } from "../stores/unread";
import { useNotifications } from "../stores/notifications";

/**
 * Marks an open thread read up to `newestId` (PROTOCOL.md §7e), like `useMarkRead` does for conversations: once when
 * it is opened, later only while the tab is visible and focused; the marker goes to the node debounced
 * (`PUT /threads/{id}/read`).
 */
export function useThreadMarkRead(threadId: string | undefined, newestId: string | undefined) {
  const newest = useRef(newestId);
  newest.current = newestId;
  const check = useRef<() => void>(() => undefined);
  const { api, domain } = useNode();
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!threadId) return;
    let opened = false;
    let sent: string | null = null;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const id = pending;
      pending = null;
      if (id) apiRef.current.threads.markRead(threadId, id).then((state) => applyThreadState(state, domain)).catch(() => undefined);
    };
    check.current = () => {
      const id = newest.current;
      if (!id || (opened && !isAttentive()) || (sent && sent >= id)) return;
      opened = true;
      sent = id;
      // The channel's count includes followed threads: what this thread had unread goes with it.
      const f = useThreads.getState().followed[threadId];
      if (f && (f.unread || f.mentions)) useUnread.getState().bump(f.channelId, -f.unread, -f.mentions);
      useThreads.getState().read(threadId, id);
      useNotifications.getState().markMessagesRead({ node: domain, threadId, messageId: id });
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
    };
  }, [threadId, domain]);

  useEffect(() => {
    check.current();
  }, [threadId, newestId]);
}
