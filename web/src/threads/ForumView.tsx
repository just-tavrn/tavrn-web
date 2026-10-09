// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, type Channel, type ForumTag, type Member, type Message, type RoomDetail, type Thread } from "@tavrn/sdk";
import { THREAD_TITLE_MAX, qualify } from "@tavrn/e2ee";
import { useLocale, useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { UnencryptedBanner } from "../components/UnencryptedBanner";
import { E2eeStatusLine, LockedNotice } from "../components/E2eeNotices";
import { Button, Dialog, ErrorText, Field, Input } from "../components/ui";
import { Select, Textarea } from "../pages/settings/common";
import { useDecrypted, useE2eeConversation } from "../hooks/useE2eeConversation";
import { ghostNoBots } from "../lib/botAccess";
import { memberName } from "../lib/memberGroups";
import { channelName } from "../lib/names";
import { describeError } from "../stores/toasts";
import { relativeTime } from "./format";
import { useThreadTitles } from "./titles";
import { createPost } from "./actions";
import { useThreads } from "./store";
import { formatCount } from "../stores/unread";
import { LockMark } from "../components/Badges";

type Sort = "activity" | "created";

/** The query key of a forum's post list. */
export function forumKey(domain: string, channelId: string, sort: Sort, tag: string | null, archived: boolean) {
  return ["threads", domain, channelId, "forum", sort, tag ?? "", archived ? "archived" : "active"];
}

/**
 * A forum channel (PROTOCOL.md §7e): its posts as cards (title, tags, author, replies, last activity and the first
 * message as preview), tag filter chips, a sort menu, archived posts on demand and the "New post" dialog. Titles and
 * messages of encrypted forums are encrypted with the channel's group like every message.
 */
export function ForumView({ room, channel, perms, roomMembers, members, refreshMembers, mayManage, domain: nodeDomain, onOpen }: {
  room: RoomDetail;
  channel: Channel;
  perms: bigint;
  roomMembers?: Member[];
  members: string[] | null;
  refreshMembers?: () => Promise<string[]>;
  mayManage: boolean;
  domain: string;
  onOpen: (threadId: string) => void;
}) {
  const t = useT();
  const { api, domain } = useNode();
  const [sort, setSort] = useState<Sort>("activity");
  const [tag, setTag] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [composing, setComposing] = useState(false);
  const canPost = hasPermission(perms, Permission.SEND_MESSAGES);
  const q = qualify(domain, channel.id);
  const e2ee = useE2eeConversation({ conversationId: q, encrypted: channel.encrypted, canCreate: canPost, members, mayManage, refreshMembers, noBots: ghostNoBots(channel, room) });
  const posts = useInfiniteQuery({
    queryKey: forumKey(domain, channel.id, sort, tag, archived),
    queryFn: ({ pageParam }) => api.threads.list(room.id, channel.id, { sort, archived: archived ? "true" : "false", limit: 25, ...(tag ? { tag } : {}), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const threads = useMemo(() => posts.data?.pages.flatMap((p) => p.items) ?? [], [posts.data]);
  const firsts = useMemo(() => threads.map((th) => th.first_message).filter((m): m is Message => !!m), [threads]);
  const decrypted = useDecrypted(q, firsts, e2ee.mls, e2ee.tick);
  const titles = useThreadTitles(q, threads, e2ee.tick);
  const names = useMemo(() => new Map((roomMembers ?? []).map((m) => [m.user.address, memberName(m)])), [roomMembers]);
  const ready = !channel.encrypted || e2ee.phase === "ready";

  const preview = (th: Thread): string => {
    const m = th.first_message;
    if (!m) return "";
    const content = (m.encrypted ? (decrypted[m.id]?.ok ? (decrypted[m.id] as { content: Record<string, unknown> }).content : null) : m.content) as { body?: unknown } | null;
    if (m.encrypted && !content) return t("messages.encrypted_short");
    return typeof content?.body === "string" ? content.body.replace(/\s+/g, " ").slice(0, 200) : "";
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="forum-view">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="text-fg-2" aria-hidden="true">
          🗂
        </span>
        <h1 className="truncate text-sm font-semibold" data-testid="channel-name">
          {channelName(channel)}
        </h1>
        {channel.encrypted && (
          <LockMark size={18} title={t("e2ee.encrypted_hint")} testId="encrypted-marker" />
        )}
        <span className="flex-1" />
        {canPost && (
          <Button onClick={() => setComposing(true)} disabled={!ready} data-testid="forum-new-post">
            {t("forum.new_post")}
          </Button>
        )}
      </header>
      {!channel.encrypted && <UnencryptedBanner domain={nodeDomain} />}
      {channel.encrypted && e2ee.phase === "locked" && <LockedNotice />}
      {channel.encrypted && e2ee.phase === "joining" && <E2eeStatusLine kind="joining" />}
      {channel.encrypted && e2ee.phase === "error" && <E2eeStatusLine kind="error" detail={e2ee.error ?? ""} />}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2" data-testid="forum-filters">
        <TagChip active={tag === null} onClick={() => setTag(null)} label={t("forum.all_tags")} testId="forum-tag-all" />
        {channel.tags?.map((tg) => (
          <TagChip key={tg.id} active={tag === tg.id} onClick={() => setTag(tag === tg.id ? null : tg.id)} label={tagLabel(tg)} testId="forum-tag-filter" />
        ))}
        <span className="flex-1" />
        <label className="flex min-h-9 items-center gap-1 text-xs text-fg-2">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={archived} onChange={(e) => setArchived(e.target.checked)} data-testid="forum-archived" />
          {t("forum.show_archived")}
        </label>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("forum.sort")} data-testid="forum-sort" className="!w-auto">
          <option value="activity">{t("forum.sort_activity")}</option>
          <option value="created">{t("forum.sort_created")}</option>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {posts.isError && <p className="text-sm text-danger">{describeError(posts.error)}</p>}
        {posts.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
        {!posts.isPending && threads.length === 0 && <p className="text-sm text-fg-2" data-testid="forum-empty">{t("forum.empty")}</p>}
        <ul className="space-y-2">
          {threads.map((th) => (
            <li key={th.id}>
              <PostCard thread={th} title={titles[th.id]} tags={channel.tags ?? []} author={names.get(th.created_by) ?? th.created_by.split("@")[0] ?? th.created_by} preview={preview(th)} onOpen={() => onOpen(th.id)} />
            </li>
          ))}
        </ul>
        {posts.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" onClick={() => void posts.fetchNextPage()} disabled={posts.isFetchingNextPage}>
              {t("forum.load_more")}
            </Button>
          </div>
        )}
      </div>
      <NewPostDialog open={composing} onClose={() => setComposing(false)} room={room} channel={channel} mls={e2ee.mls} onCreated={(id) => { setComposing(false); onOpen(id); }} />
    </div>
  );
}

function tagLabel(tg: ForumTag): string {
  return tg.emoji && !tg.emoji.startsWith("<") ? `${tg.emoji} ${tg.name}` : tg.name;
}

function TagChip({ active, onClick, label, testId }: { active: boolean; onClick: () => void; label: string; testId?: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className="min-h-8 rounded-full border border-line px-3 text-xs text-fg-1 hover:border-accent aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent" data-testid={testId}>
      {label}
    </button>
  );
}

function PostCard({ thread, title, tags, author, preview, onOpen }: { thread: Thread; title: string | null | undefined; tags: ForumTag[]; author: string; preview: string; onOpen: () => void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const unread = useThreads((s) => s.followed[thread.id]?.unread ?? 0);
  const replies = Math.max(0, thread.message_count - 1);
  return (
    <button type="button" onClick={onOpen} className="block w-full rounded-md border border-line bg-bg-1 p-3 text-left hover:border-accent" data-testid="forum-post" data-thread-id={thread.id}>
      <span className="flex items-start gap-2">
        <span className={`min-w-0 flex-1 truncate text-sm ${unread > 0 ? "font-semibold text-fg-0" : "font-medium text-fg-0"}`} data-testid="forum-post-title">
          {thread.encrypted && <LockMark title={t("e2ee.encrypted_hint")} className="mr-1 align-[-3px]" />}
          {title ?? (title === null ? t("threads.title_unreadable") : t("common.loading"))}
        </span>
        {unread > 0 && (
          <span className="shrink-0 rounded-full bg-danger-solid px-1.5 text-[10px] font-semibold leading-4 text-white">{formatCount(unread)}</span>
        )}
      </span>
      {thread.tags.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {thread.tags.map((id) => {
            const tg = tags.find((x) => x.id === id);
            return tg ? (
              <span key={id} className="rounded-full bg-bg-3 px-2 text-[11px] text-fg-1" data-testid="forum-post-tag">
                {tagLabel(tg)}
              </span>
            ) : null;
          })}
        </span>
      )}
      {preview && <span className="mt-1 line-clamp-2 block text-xs text-fg-2">{preview}</span>}
      <span className="mt-1 block text-xs text-fg-2">
        {author} · {t(replies === 1 ? "threads.replies_one" : "threads.replies_many", { count: replies })} · {relativeTime(thread.last_message_at, locale)}
        {thread.locked ? ` · ${t("threads.locked")}` : ""}
      </span>
    </button>
  );
}

function NewPostDialog({ open, onClose, room, channel, mls, onCreated }: { open: boolean; onClose: () => void; room: RoomDetail; channel: Channel; mls: import("@tavrn/e2ee").MlsManager | null; onCreated: (id: string) => void }) {
  const t = useT();
  const { api, domain, home } = useNode();
  const queryClient = useQueryClient();
  // Nodes announcing `threads.client_ids` keep the client's thread id: the first message is signed with it.
  const nodeInfo = useQuery({ queryKey: home ? ["node"] : ["node", domain], queryFn: () => api.node.info(), staleTime: 10 * 60_000 });
  const clientIds = !!nodeInfo.data?.capabilities?.includes("threads.client_ids");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = !!title.trim() && Array.from(title.trim()).length <= THREAD_TITLE_MAX && !!body.trim();
  const reset = () => {
    setTitle("");
    setBody("");
    setTags([]);
    setError(null);
  };
  return (
    <Dialog title={t("forum.new_post")} open={open} onClose={onClose}>
      <form
        className="space-y-4"
        data-testid="forum-post-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid || busy) return;
          setBusy(true);
          setError(null);
          try {
            if (channel.encrypted && !mls) throw new Error(t("e2ee.composer_locked"));
            const id = await createPost({ api, domain, roomId: room.id, channelId: channel.id, encrypted: channel.encrypted, title: title.trim(), tags, body: body.trim(), mls, clientIds });
            await queryClient.invalidateQueries({ queryKey: ["threads", domain, channel.id] });
            reset();
            onCreated(id);
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("threads.title")} hint={channel.encrypted ? t("threads.title_encrypted_hint") : t("threads.title_plain_hint")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={THREAD_TITLE_MAX} required data-testid="forum-post-title-input" />
        </Field>
        <Field label={t("forum.message")}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} required data-testid="forum-post-body" />
        </Field>
        {(channel.tags?.length ?? 0) > 0 && (
          <fieldset className="space-y-1">
            <legend className="text-sm text-fg-1">{t("forum.tags")}</legend>
            <div className="flex flex-wrap gap-2">
              {channel.tags!.map((tg) => (
                <TagChip key={tg.id} active={tags.includes(tg.id)} onClick={() => setTags((cur) => (cur.includes(tg.id) ? cur.filter((x) => x !== tg.id) : cur.length < 5 ? [...cur, tg.id] : cur))} label={tagLabel(tg)} testId="forum-post-tag-option" />
              ))}
            </div>
          </fieldset>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!valid || busy} data-testid="forum-post-submit">
            {t("forum.publish")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
