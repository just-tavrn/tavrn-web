// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams } from "react-router";
import { DIRECT_PERMISSIONS, isBotKind, type Conversation, type User } from "@tavrn/sdk";
import { api } from "../lib/api";
import { findDm, indexConversation, indexLeftConversation } from "../stores/conversationIndex";
import { useAuth } from "../stores/auth";
import { isHome, useNodes } from "../stores/nodes";
import { useT } from "../i18n";
import { describeError, toastError } from "../stores/toasts";
import { useUnread } from "../stores/unread";
import { useShell } from "../components/AppShell";
import { conversationPath, useNode } from "../components/NodeScope";
import { Avatar, Button, Dialog, ErrorText, Field, Input } from "../components/ui";
import { BotBadge, KeyChangedBadge, UnreadBadges, useHasUnread } from "../components/Badges";
import { ConversationView } from "../components/ConversationView";
import { CallButton } from "../voice/calls/CallUi";
import { VerifiedBadge, VerifyButton } from "../components/Verification";
import { UserAvatar } from "../components/Avatar";
import { DmRefusedNotice, ProfileTrigger } from "../components/ProfilePopover";
import { MessageRequestsLink } from "../components/MessageRequests";
import { MenuButton } from "../components/ContextMenu";
import { isClosed, useClosedDms, useDmMenu } from "../components/menus/DmMenu";
import { useOriginDomain } from "../lib/origin";
import { conversationsQuery, nodeInfoQuery } from "../lib/queries";

/** A DM or group DM together with the domain of the node that hosts it. */
export type NodeConversation = Conversation & { node: string };

/** The conversation list of one node (null: the home node); it carries the unread counts (design note 4.4, lib/queries.ts). */
const conversationsOf = (domain: string | null) => conversationsQuery(domain);

/** Newest activity first; message and conversation ids are ULIDs (time-ordered). */
const activity = (c: Conversation) => (c.last_message_id && c.last_message_id > c.id ? c.last_message_id : c.id);

/** Merges the lists of several nodes (pure, for the hook below and tests). */
export function mergeConversations(lists: Array<{ node: string; items: Conversation[] | undefined }>): NodeConversation[] {
  const seen = new Set<string>();
  const out: NodeConversation[] = [];
  for (const { node, items } of lists) {
    for (const c of items ?? []) {
      const key = `${node}/${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...c, node });
    }
  }
  return out.sort((a, b) => activity(b).localeCompare(activity(a)));
}

/**
 * DMs and group DMs of every node: a conversation lives on its initiator's home node (FEDERATION.md
 * §6.1), so the list is the home node's plus those of the other nodes with a session. A node that cannot
 * be reached keeps the conversations it listed last.
 */
export function useConversations(): { data: NodeConversation[] | undefined; isError: boolean; error: unknown } {
  const homeDomain = useAuth((s) => s.user?.domain ?? "");
  const domains = useNodes((s) => Object.keys(s.sessions).sort().join(","));
  const foreign = domains ? domains.split(",").filter((d) => d !== homeDomain) : [];
  return useQueries({
    queries: [conversationsOf(null), ...foreign.map((d) => ({ ...conversationsOf(d), retry: 1 }))],
    combine: (results) => ({
      data: results[0]?.data ? mergeConversations([{ node: homeDomain, items: results[0].data }, ...foreign.map((node, i) => ({ node, items: results[i + 1]?.data }))]) : undefined,
      isError: !!results[0]?.isError,
      error: results[0]?.error,
    }),
  });
}

export function useFriends() {
  return useQuery({ queryKey: ["friends"], queryFn: () => api.friends.list() });
}

function useNodeInfo() {
  return useQuery(nodeInfoQuery(null));
}

/** Display title of a DM (the other person) or group DM (its name or the members). */
export function conversationTitle(c: Conversation, meAddress: string | undefined): string {
  const others = c.members.filter((m) => m.address !== meAddress);
  if (c.kind === "group") return c.name || others.map((m) => m.display_name).join(", ") || "—";
  return others[0]?.display_name ?? "—";
}

/**
 * Opens the DM with `peer` (an address of any node): an existing DM from the conversation index, on
 * whichever node it lives (FEDERATION.md §6.1, DM uniqueness), otherwise a new one on the home node.
 * Returns the route of the conversation.
 */
export async function openDm(peer: string, queryClient: QueryClient): Promise<string> {
  const existing = findDm(peer);
  if (existing?.conversation_id) return conversationPath(existing.node, existing.conversation_id);
  const c = await api.conversations.create({ kind: "dm", members: [peer] });
  void indexConversation(null, c.kind, c.id, peer);
  await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  return conversationPath(null, c.id);
}

/** Sidebar of the home view: friends link, direct messages and group DMs. */
export function HomeSidebar() {
  const t = useT();
  const me = useAuth((s) => s.user);
  const conversations = useConversations();
  const friends = useFriends();
  const { closeNav } = useShell();
  const [dialog, setDialog] = useState<"dm" | "group" | null>(null);
  const incoming = friends.data?.incoming.length ?? 0;
  // Closed DMs stay hidden until a newer message arrives (design note 4.11); the open one is always listed.
  const closed = useClosedDms((s) => s.closed);
  const lastKnown = useUnread((s) => s.states);
  const params = useParams();
  const visible = conversations.data?.filter((c) => c.id === params.conversationId || !isClosed(closed, c, lastKnown[c.id]?.last ?? null));
  return (
    <div className="flex flex-col">
      <div className="flex h-12 items-center border-b border-line px-3">
        <h2 className="text-sm font-semibold">{t("shell.home")}</h2>
      </div>
      <nav aria-label={t("dm.title")} className="p-2">
        <NavLink to="/friends" onClick={closeNav} className={({ isActive }) => `flex min-h-10 items-center gap-2 rounded-md px-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
          <span aria-hidden="true" className="w-5 text-center">
            👥
          </span>
          <span className="flex-1">{t("friends.title")}</span>
          {incoming > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-xs text-accent-text" data-testid="friends-incoming-count">
              {incoming}
            </span>
          )}
        </NavLink>
        <MessageRequestsLink />
        <div className="mt-3 flex items-center gap-1 px-2 pb-1">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2">{t("dm.title")}</span>
          <button type="button" aria-label={t("dm.new")} title={t("dm.new")} onClick={() => setDialog("dm")} className="min-h-8 min-w-8 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0">
            +
          </button>
          <button type="button" aria-label={t("dm.new_group")} title={t("dm.new_group")} onClick={() => setDialog("group")} className="min-h-8 min-w-8 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0">
            ⊕
          </button>
        </div>
        {conversations.isError && <p className="px-2 text-xs text-danger">{describeError(conversations.error)}</p>}
        {visible?.length === 0 && <p className="px-2 text-xs text-fg-2">{t("dm.none")}</p>}
        <ul data-testid="dm-list">
          {visible?.map((c) => (
            <li key={`${c.node}/${c.id}`}>
              <ConversationLink conversation={c} meAddress={me?.address} onClick={closeNav} />
            </li>
          ))}
        </ul>
      </nav>
      <NewConversationDialog kind={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

function ConversationLink({ conversation: c, meAddress, onClick }: { conversation: NodeConversation; meAddress: string | undefined; onClick: () => void }) {
  const t = useT();
  const unread = useHasUnread(c.id);
  const others = c.members.filter((m) => m.address !== meAddress);
  const title = conversationTitle(c, meAddress);
  const foreign = !isHome(c.node);
  // Context menu (design note 4.11): right-click, long press, keyboard or the ⋯ button.
  const { menu, overlay } = useDmMenu(c, meAddress);
  return (
    <div className="group relative flex items-center" data-testid="dm-row" data-conversation={c.id}>
    <NavLink to={conversationPath(c.node, c.id)} onClick={onClick} {...menu.triggerProps} data-unread={unread || undefined} data-node={c.node} title={c.kind === "dm" && others[0] ? others[0].address : title} className={({ isActive }) => `flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : unread ? "text-fg-0 hover:bg-bg-3/60" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
      {c.kind === "dm" && others[0] ? <UserAvatar user={others[0]} size={24} node={c.node} presence /> : <Avatar name={title} size={24} />}
      <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>{title}</span>
      {/* Conversations hosted on another node always show its domain (design note 9d). */}
      {foreign && (
        <span className="max-w-24 shrink truncate text-[10px] text-fg-2" title={t("dm.hosted_on", { domain: c.node })} data-testid="conversation-node">
          {c.node}
        </span>
      )}
      {c.kind === "dm" && isBotKind(others[0]?.kind) && <BotBadge />}
      {c.kind === "group" && <span className="text-xs text-fg-2">{c.members.length}</span>}
      <UnreadBadges conversationId={c.id} />
    </NavLink>
    <MenuButton menu={menu} label={t("menu.dm.open", { name: title })} className="pointer-events-none absolute right-1 bg-bg-1 opacity-0 focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:hidden" testId="dm-menu-button" />
    {overlay}
    </div>
  );
}

/** New DM (pick a friend, or any local user under `dm_policy = open`) or new group DM (name + 1–49 others). */
function NewConversationDialog({ kind, onClose }: { kind: "dm" | "group" | null; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { closeNav } = useShell();
  const friends = useFriends();
  const node = useNodeInfo();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<{ error: unknown; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Under `friends` only friends can be picked; otherwise non-friends get a message request (design note 4.9).
  const open = !!node.data && node.data.dm_policy !== "friends";
  const close = () => {
    setName("");
    setPicked([]);
    setUsername("");
    setError(null);
    onClose();
  };
  const start = async (members: string[]) => {
    setBusy(true);
    setError(null);
    try {
      let path: string;
      if (kind !== "group" && members.length === 1) {
        path = await openDm(members[0]!, queryClient);
      } else {
        // Group DMs live on the creator's home node; members may be of any node (FEDERATION.md §6.1).
        const c = await api.conversations.create({ kind: "group", members, name: name.trim() || null });
        void indexConversation(null, c.kind, c.id, null);
        await queryClient.invalidateQueries({ queryKey: ["conversations"] });
        path = conversationPath(null, c.id);
      }
      close();
      closeNav();
      navigate(path);
    } catch (e) {
      setError({ error: e, address: members[0] ?? "" });
    } finally {
      setBusy(false);
    }
  };
  const typed = username
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  const friendList = friends.data?.friends ?? [];
  return (
    <Dialog title={kind === "group" ? t("dm.new_group") : t("dm.new")} open={kind !== null} onClose={close}>
      <div className="space-y-3">
        {kind === "group" && (
          <Field label={t("dm.group_name")}>
            <Input name="group_name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
        )}
        <p className="text-xs text-fg-2">{friendList.length ? t("dm.pick_friend") : t("dm.no_friends")}</p>
        <ul className="max-h-60 space-y-1 overflow-y-auto" data-testid="dm-friend-picker">
          {friendList.map(({ user }) => (
            <li key={user.id}>
              {kind === "group" ? (
                <label className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm hover:bg-bg-3/60">
                  <input type="checkbox" className="h-4 w-4" checked={picked.includes(user.address)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, user.address] : p.filter((a) => a !== user.address)))} />
                  <UserLine user={user} />
                </label>
              ) : (
                <button type="button" disabled={busy} onClick={() => void start([user.address])} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-bg-3/60">
                  <UserLine user={user} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {open && (
          <Field label={kind === "group" ? t("dm.usernames") : t("dm.username")} hint={t("dm.username_hint")}>
            <Input name="dm_username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
        )}
        {error && <DmRefusedNotice error={error.error} address={error.address} name={error.address} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          {(kind === "group" || open) && (
            <Button disabled={busy || (kind === "group" ? picked.length + typed.length < 1 || picked.length + typed.length > 49 : typed.length !== 1)} onClick={() => void start([...picked, ...typed])}>
              {kind === "group" ? t("dm.create_group") : t("dm.start")}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Display name with the full address (design note 9d: security-relevant places show the address). */
export function UserLine({ user }: { user: User }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <ProfileTrigger user={user} className="shrink-0 rounded-full">
        <UserAvatar user={user} size={24} presence />
      </ProfileTrigger>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{user.display_name}</span>
        <span className="block truncate text-xs text-fg-2" data-testid="user-address">
          {user.address}
        </span>
      </span>
      {isBotKind(user.kind) && <BotBadge />}
      <KeyChangedBadge address={user.address} />
      <VerifiedBadge address={user.address} compact />
      <VerifyButton address={user.address} name={user.display_name} />
    </span>
  );
}

/** A DM or group DM (route `/conversations/:conversationId`); always end-to-end encrypted. */
export function ConversationPage() {
  const t = useT();
  const { conversationId = "" } = useParams();
  // The node hosting the conversation (home, or another node under /n/<domain>, FEDERATION.md §6.1).
  const { api: nodeApi, me, domain } = useNode();
  const originDomain = useOriginDomain();
  // The node domain is the identity domain from its discovery document, never the page host (design note 4.2c).
  const nodeDomain = domain || originDomain || "";
  const queryClient = useQueryClient();
  const conv = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => nodeApi.conversations.get(conversationId), enabled: !!conversationId });
  // The member list of the hosting node is what the ghost check compares the MLS roster with (§4.6).
  const members = useMemo(() => conv.data?.members.map((m) => m.address) ?? null, [conv.data]);
  const bots = useMemo(() => new Set((conv.data?.members ?? []).filter((m) => isBotKind(m.kind)).map((m) => m.address)), [conv.data]);
  if (conv.isPending) return <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>;
  if (conv.isError) return <p className="p-4 text-sm text-danger">{describeError(conv.error)}</p>;
  const c = conv.data;
  const title = conversationTitle(c, me?.address);
  const other = c.kind === "dm" ? c.members.find((m) => m.address !== me?.address) : undefined;
  const header = (
    <>
      <span className="text-fg-2" aria-hidden="true">
        {c.kind === "group" ? "👥" : "@"}
      </span>
      <h1 className="truncate text-sm font-semibold" data-testid="conversation-name">
        {title}
      </h1>
      {other && (
        <span className="hidden truncate text-xs text-fg-2 sm:inline" data-testid="conversation-address">
          {other.address}
        </span>
      )}
      {isBotKind(other?.kind) && <BotBadge />}
      {other && <KeyChangedBadge address={other.address} />}
      {other && <VerifiedBadge address={other.address} />}
      {other && <VerifyButton address={other.address} name={other.display_name} />}
      {c.kind === "group" && <RenameGroupButton conversation={c} />}
      <CallButton conversation={c} />
    </>
  );
  return (
    <ConversationView
      key={c.id}
      conversationId={c.id}
      encrypted
      header={header}
      placeholder={t("dm.placeholder", { name: title })}
      canSend
      canManage={false}
      canAttach
      canReact
      canPin
      members={members}
      refreshMembers={async () => (await queryClient.fetchQuery({ queryKey: ["conversation", c.id], queryFn: () => nodeApi.conversations.get(c.id), staleTime: 0 })).members.map((m) => m.address)}
      direct={members ?? undefined}
      mayManage
      bots={bots}
      people={c.members}
      domain={nodeDomain}
      mentionContext={{ domain: nodeDomain, users: c.members.map((m) => ({ address: m.address })), canMentionEveryone: false }}
      permissions={DIRECT_PERMISSIONS}
    />
  );
}

/** Any member may rename a group DM (`PATCH /conversations/{id}`); an empty name shows the members. */
function RenameGroupButton({ conversation }: { conversation: Conversation }) {
  const t = useT();
  const { api } = useNode();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.conversations.update(conversation.id, { name: name.trim() || null });
      queryClient.setQueryData(["conversation", conversation.id], updated);
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setOpen(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        aria-label={t("dm.rename")}
        title={t("dm.rename")}
        onClick={() => {
          setName(conversation.name ?? "");
          setError(null);
          setOpen(true);
        }}
        className="min-h-10 min-w-10 shrink-0 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0"
      >
        ✎
      </button>
      <Dialog title={t("dm.rename_title")} open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={t("dm.group_name")} hint={t("dm.rename_hint")}>
            <Input name="group_name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Member list of a DM or group DM with full addresses; groups can add, remove (creator) and leave. */
export function ConversationMembers({ conversationId }: { conversationId: string }) {
  const t = useT();
  const { closeMembers } = useShell();
  // Members are managed on the node hosting the conversation; user ids are node-local, addresses global.
  const { api, me, domain } = useNode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const conv = useQuery({ queryKey: ["conversation", conversationId], queryFn: () => api.conversations.get(conversationId) });
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!conv.data) return null;
  const c = conv.data;
  const isCreator = c.creator === me?.address;
  const refresh = async (next?: Conversation) => {
    if (next) queryClient.setQueryData(["conversation", conversationId], next);
    await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };
  const add = async () => {
    setError(null);
    try {
      await refresh(await api.conversations.addMember(conversationId, adding.trim()));
      setAdding("");
    } catch (e) {
      setError(describeError(e));
    }
  };
  const remove = async (user: User) => {
    const self = user.address === me?.address;
    if (!confirm(self ? t("dm.leave_confirm") : t("dm.remove_confirm", { address: user.address }))) return;
    try {
      await api.conversations.removeMember(conversationId, user.address);
      if (self) {
        void indexLeftConversation(domain, c.kind, conversationId);
        await refresh();
        queryClient.removeQueries({ queryKey: ["conversation", conversationId] });
        closeMembers();
        navigate("/");
      } else {
        await queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
        await refresh();
      }
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div>
      <h2 className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-2">{t("members.count", { count: c.members.length })}</h2>
      <ul className="space-y-1" data-testid="conversation-members">
        {c.members.map((m) => (
          <li key={m.id} className="flex min-h-10 items-center gap-1 rounded-md px-1 text-sm text-fg-1">
            <UserLine user={m} />
            {c.kind === "group" && isCreator && m.address !== me?.address && (
              <button type="button" aria-label={t("dm.remove_member", { name: m.display_name })} onClick={() => void remove(m)} className="min-h-8 min-w-8 rounded text-fg-2 hover:bg-bg-3 hover:text-danger">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {c.kind === "group" && (
        <div className="mt-3 space-y-2">
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (adding.trim()) void add();
            }}
          >
            <Input aria-label={t("dm.add_member")} placeholder={t("dm.add_member")} value={adding} onChange={(e) => setAdding(e.target.value)} />
            <Button type="submit" variant="ghost" disabled={!adding.trim()}>
              +
            </Button>
          </form>
          <ErrorText>{error}</ErrorText>
          <Button variant="danger" className="w-full" onClick={() => {
            const self = c.members.find((m) => m.address === me?.address);
            if (self) void remove(self);
          }}>
            {t("dm.leave")}
          </Button>
        </div>
      )}
    </div>
  );
}
