// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Channel, Thread } from "@tavrn/sdk";
import { qualify } from "@tavrn/e2ee";
import { useLocale, useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { formatCount } from "../stores/unread";
import { relativeTime } from "./format";
import { useThreadTitles } from "./titles";
import { useThreads } from "./store";
import { LockMark } from "../components/Badges";

/** The query key of a channel's thread list. */
export function threadListKey(domain: string, channelId: string, archived: boolean) {
  return ["threads", domain, channelId, archived ? "archived" : "active"];
}

/**
 * "Threads" in the channel header (PROTOCOL.md §7e): the badge sums the unread messages of followed threads; the
 * popover lists the active and the archived threads with their unread counts and opens one; "New thread" starts a
 * standalone thread.
 */
export function ThreadsButton({ channel, onOpen, onNew }: { channel: Channel; onOpen: (threadId: string) => void; onNew?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const followed = useThreads((s) => s.followed);
  const unread = Object.values(followed).filter((f) => f.channelId === channel.id).reduce((n, f) => n + f.unread, 0);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("threads.list")}
        onClick={() => setOpen((v) => !v)}
        className="relative min-h-10 min-w-10 rounded-md px-1 text-fg-2 hover:bg-bg-3 hover:text-fg-0 aria-expanded:bg-accent-soft aria-expanded:text-accent"
        data-testid="threads-button"
      >
        🧵
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger-solid px-1 text-[10px] font-semibold leading-4 text-white" data-testid="threads-unread">
            {formatCount(unread)}
          </span>
        )}
      </button>
      {open && (
        <ThreadsPopover
          channel={channel}
          onOpen={(id) => {
            setOpen(false);
            onOpen(id);
          }}
          onNew={
            onNew &&
            (() => {
              setOpen(false);
              onNew();
            })
          }
        />
      )}
    </div>
  );
}

function ThreadsPopover({ channel, onOpen, onNew }: { channel: Channel; onOpen: (id: string) => void; onNew?: () => void }) {
  const t = useT();
  const { api, domain } = useNode();
  const [archived, setArchived] = useState(false);
  const list = useQuery({
    queryKey: threadListKey(domain, channel.id, archived),
    queryFn: () => api.threads.list(channel.room_id, channel.id, { archived: archived ? "true" : "false", limit: 50 }),
  });
  return (
    <div role="dialog" aria-label={t("threads.list")} className="absolute right-0 top-11 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-line bg-bg-1 p-2 shadow-xl" data-testid="threads-popover">
      <div className="mb-2 flex items-center gap-1" role="tablist">
        {[false, true].map((a) => (
          <button key={String(a)} type="button" role="tab" aria-selected={archived === a} onClick={() => setArchived(a)} className="min-h-9 rounded-md px-2 text-sm text-fg-2 hover:bg-bg-3 aria-selected:bg-bg-3 aria-selected:text-fg-0" data-testid={a ? "threads-tab-archived" : "threads-tab-active"}>
            {a ? t("threads.tab_archived") : t("threads.tab_active")}
          </button>
        ))}
        <span className="flex-1" />
        {onNew && (
          <button type="button" onClick={onNew} className="min-h-9 rounded-md px-2 text-sm text-accent hover:bg-bg-3" data-testid="threads-new">
            {t("threads.new")}
          </button>
        )}
      </div>
      {list.isPending && <p className="p-2 text-sm text-fg-2">{t("common.loading")}</p>}
      {list.data?.items.length === 0 && <p className="p-2 text-sm text-fg-2">{archived ? t("threads.none_archived") : t("threads.none")}</p>}
      {list.data && <ThreadRows channel={channel} threads={list.data.items} onOpen={onOpen} />}
    </div>
  );
}

function ThreadRows({ channel, threads, onOpen }: { channel: Channel; threads: Thread[]; onOpen: (id: string) => void }) {
  const t = useT();
  const { domain } = useNode();
  const locale = useLocale((s) => s.locale);
  const titles = useThreadTitles(qualify(domain, channel.id), threads);
  const followed = useThreads((s) => s.followed);
  return (
    <ul className="max-h-80 space-y-0.5 overflow-y-auto">
      {threads.map((th) => {
        const title = titles[th.id];
        const unread = followed[th.id]?.unread ?? 0;
        return (
          <li key={th.id}>
            <button type="button" onClick={() => onOpen(th.id)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-bg-3" data-testid="thread-row" data-thread-id={th.id}>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${unread > 0 ? "font-semibold text-fg-0" : "text-fg-1"}`}>
                  {th.encrypted && <LockMark title={t("e2ee.encrypted_hint")} className="mr-1 align-[-3px]" />}
                  {title ?? (title === null ? t("threads.title_unreadable") : t("common.loading"))}
                </span>
                <span className="block truncate text-xs text-fg-2">
                  {t(th.message_count === 1 ? "threads.replies_one" : "threads.replies_many", { count: th.message_count })} · {relativeTime(th.last_message_at, locale)}
                  {th.locked ? ` · ${t("threads.locked")}` : ""}
                </span>
              </span>
              {unread > 0 && (
                <span className="rounded-full bg-danger-solid px-1.5 text-[10px] font-semibold leading-4 text-white" data-testid="thread-row-unread">
                  {formatCount(unread)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
