// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, type Channel } from "@tavrn/sdk";
import { THREAD_TITLE_MAX, qualify } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { ConversationView } from "../components/ConversationView";
import { ContextMenu, MenuButton, useContextMenu } from "../components/ContextMenu";
import { threadMenu } from "../lib/menus";
import { Button, Dialog, Field, Input } from "../components/ui";
import { describeError, toastError } from "../stores/toasts";
import { confirmDialog } from "../components/Confirm";
import { channelName } from "../lib/names";
import { sealTitle, useThreadTitles } from "./titles";
import { useThreads } from "./store";

type ViewProps = Omit<ComponentProps<typeof ConversationView>, "header" | "placeholder" | "canSend" | "threadId" | "threadRoot" | "onThread" | "composerNote" | "jumpEnabled" | "canStartThreads">;

/** The query key of one thread on a node. */
export function threadKey(domain: string, threadId: string) {
  return ["thread", domain, threadId];
}

/**
 * The thread panel (PROTOCOL.md §7e): the thread's messages in a conversation view of the channel in thread mode, with
 * its title (decrypted in encrypted channels), follow, rename, archive, lock and delete. Side panel next to the channel
 * on tablets and desktops, full screen with a back button on phones; Esc closes it.
 */
export function ThreadPanel({ threadId, channel, perms, onClose, view }: { threadId: string; channel: Channel; perms: bigint; onClose: () => void; view: ViewProps }) {
  const t = useT();
  const { api, domain, me } = useNode();
  const queryClient = useQueryClient();
  const thread = useQuery({ queryKey: threadKey(domain, threadId), queryFn: () => api.threads.get(threadId) });
  const q = qualify(domain, channel.id);
  const one = useMemo(() => (thread.data ? [thread.data] : undefined), [thread.data]);
  const titles = useThreadTitles(q, one);
  const following = useThreads((s) => !!s.followed[threadId]);
  const [renaming, setRenaming] = useState(false);
  const menu = useContextMenu();

  // Esc closes the panel, unless a dialog or menu above it takes the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // The server's follow state seeds the local one.
  useEffect(() => {
    const d = thread.data;
    if (d?.me) useThreads.getState().state({ thread_id: d.id, channel_id: d.channel_id, room_id: d.room_id, following: d.me.following, last_read_message_id: d.me.last_read_message_id ?? null, unread_count: d.me.unread_count, mention_count: d.me.mention_count }, domain);
  }, [thread.data, domain]);
  useEffect(() => {
    useThreads.setState({ open: threadId });
    return () => useThreads.setState((s) => (s.open === threadId ? { open: null } : s));
  }, [threadId]);

  if (thread.isPending) return <PanelFrame onClose={onClose} title={t("common.loading")} />;
  if (thread.isError || !thread.data) return <PanelFrame onClose={onClose} title={t("threads.not_found")} detail={thread.isError ? describeError(thread.error) : undefined} />;
  const d = thread.data;
  const title = titles[d.id];
  const shownTitle = title === undefined ? t("common.loading") : title === null ? t("threads.title_unreadable") : title;
  const moderator = hasPermission(perms, Permission.MANAGE_THREADS);
  const mayManage = moderator || d.created_by_id === me?.id;
  const forum = channel.kind === "forum";
  const canWrite =
    hasPermission(perms, Permission.SEND_MESSAGES) && (forum || hasPermission(perms, Permission.CREATE_THREADS)) && (!d.locked || moderator);
  const refresh = () => queryClient.invalidateQueries({ queryKey: threadKey(domain, threadId) });
  const update = async (patch: Parameters<typeof api.threads.update>[1]) => {
    try {
      queryClient.setQueryData(threadKey(domain, threadId), await api.threads.update(threadId, patch));
    } catch (e) {
      toastError(e);
    }
  };
  const toggleFollow = async () => {
    try {
      useThreads.getState().state(following ? await api.threads.unfollow(threadId) : await api.threads.follow(threadId), domain);
    } catch (e) {
      toastError(e);
    }
  };
  const menuEntries = menu.open
    ? threadMenu(
        { mayManage, archived: !!d.archived_at, locked: d.locked },
        {
          rename: () => setRenaming(true),
          setArchived: (archived) => void update({ archived }),
          setLocked: (locked) => void update({ locked }),
          remove: async () => {
            if (!(await confirmDialog({ title: t("threads.delete"), text: t("threads.delete_confirm"), confirmLabel: t("common.delete"), danger: true }))) return;
            try {
              await api.threads.delete(threadId);
              onClose();
            } catch (e) {
              toastError(e);
            }
          },
        },
        t,
      )
    : [];
  const header = (
    <>
      <button type="button" onClick={onClose} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("threads.close")} data-testid="thread-close">
        <span className="md:hidden">←</span>
        <span className="hidden md:inline">×</span>
      </button>
      <span className="hidden shrink-0 text-xs text-fg-2 sm:inline">#{channelName(channel)} ›</span>
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="thread-title">
        {shownTitle}
      </h2>
      {d.root_deleted && <span className="hidden shrink-0 text-xs italic text-fg-2 sm:inline" data-testid="thread-root-deleted">{t("threads.root_deleted")}</span>}
      {d.locked && <span className="shrink-0 text-xs text-fg-2" data-testid="thread-locked">{t("threads.locked")}</span>}
      {d.archived_at && <span className="shrink-0 text-xs text-fg-2" data-testid="thread-archived">{t("threads.archived")}</span>}
      <button type="button" onClick={() => void toggleFollow()} aria-pressed={following} className="min-h-10 shrink-0 rounded-md px-2 text-xs text-fg-2 hover:bg-bg-3 hover:text-fg-0 aria-pressed:text-accent" data-testid="thread-follow">
        {following ? t("threads.following") : t("threads.follow")}
      </button>
      {mayManage && <MenuButton menu={menu} label={t("threads.menu")} testId="thread-menu-button" />}
      {menu.open && menu.anchor && <ContextMenu entries={menuEntries} anchor={menu.anchor} onClose={menu.close} label={t("threads.menu")} testId="thread-menu" />}
    </>
  );
  return (
    <>
      <ConversationView
        {...view}
        key={threadId}
        threadId={threadId}
        threadRoot={d.root_message ?? null}
        header={header}
        placeholder={t("threads.placeholder")}
        canSend={canWrite}
        composerNote={canWrite ? undefined : d.locked ? t("threads.locked_note") : t("messages.no_permission")}
        jumpEnabled
      />
      <RenameDialog
        open={renaming}
        initial={typeof title === "string" ? title : ""}
        onClose={() => setRenaming(false)}
        onSave={async (next) => {
          await api.threads.update(threadId, await sealTitle(q, d.encrypted, next, null, threadId));
          setRenaming(false);
          await refresh();
        }}
      />
    </>
  );
}

function PanelFrame({ title, detail, onClose }: { title: string; detail?: string; onClose: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={onClose} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("threads.close")} data-testid="thread-close">
          ×
        </button>
        <h2 className="truncate text-sm font-semibold">{title}</h2>
      </header>
      {detail && <p className="p-4 text-sm text-danger">{detail}</p>}
    </div>
  );
}

function RenameDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (title: string) => Promise<void> }) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Dialog title={t("threads.rename")} open={open} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(value.trim());
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("threads.title")}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={THREAD_TITLE_MAX} required data-testid="thread-rename-input" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !value.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

