// SPDX-License-Identifier: Apache-2.0
/**
 * Message requests (design note 4.9): DMs and group DMs of people who are not my friends wait here until I
 * accept them (a normal conversation) or decline them (optionally blocking the sender with a private
 * note). Requests of my home node come from `GET /conversations/requests`; requests hosted on other
 * nodes arrive in the invite list of the home node (`conversation.requested`, FEDERATION.md §6.1) and
 * are accepted or declined on the hosting node with a federated session.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router";
import type { PendingInvite } from "@tavrn/sdk";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { apiFor, connectNode, isHome } from "../stores/nodes";
import { indexConversation } from "../stores/conversationIndex";
import { toastError, useToasts } from "../stores/toasts";
import { conversationPath } from "./NodeScope";
import { usePendingInvites } from "./InviteList";
import { useShell } from "./AppShell";
import { NOTE_MAX } from "./FriendRequestForm";
import { Button, Dialog, Field, Input } from "./ui";

/** One request, wherever it is hosted. */
export interface RequestItem {
  /** Domain of the hosting node, null for the home node. */
  node: string | null;
  conversationId: string;
  kind: "dm" | "group";
  /** Address of the sender. */
  from: string;
  fromName: string;
  /** Names of the rooms shared with the sender (rooms of the hosting node or vouched for by it). */
  sharedRooms: string[];
  createdAt: string;
  /** Entry of the invite list on the home node (requests hosted elsewhere). */
  inviteId?: string;
}

type ConversationSummary = { id?: string; kind?: string; requested?: boolean; shared_rooms?: Array<{ name?: string }> };

/** Requests from both sources, newest first (pure, for the hook and tests). */
export function mergeRequests(local: Array<{ conversation: { id: string; kind: string; created_at: string }; from?: { address: string; display_name: string } | null; shared_rooms: Array<{ name: string }> }>, invites: PendingInvite[] | null | undefined): RequestItem[] {
  const out: RequestItem[] = local.map((r) => ({
    node: null,
    conversationId: r.conversation.id,
    kind: r.conversation.kind === "group" ? "group" : "dm",
    from: r.from?.address ?? "",
    fromName: r.from?.display_name ?? r.from?.address ?? "",
    sharedRooms: r.shared_rooms.map((s) => s.name),
    createdAt: r.conversation.created_at,
  }));
  for (const inv of invites ?? []) {
    const c = inv.conversation as ConversationSummary | null | undefined;
    if (inv.kind !== "conversation" || !c?.requested || !c.id || isHome(inv.node)) continue;
    out.push({
      node: inv.node,
      conversationId: c.id,
      kind: c.kind === "group" ? "group" : "dm",
      from: inv.inviter,
      fromName: inv.inviter,
      sharedRooms: (c.shared_rooms ?? []).map((s) => s.name ?? "").filter(Boolean),
      createdAt: inv.received_at,
      inviteId: inv.id,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function useMessageRequests() {
  const local = useQuery({ queryKey: ["requests"], queryFn: () => api.requests.list(), retry: false });
  const invites = usePendingInvites();
  return { data: local.data ? mergeRequests(local.data, invites.data) : undefined, isError: local.isError, error: local.error };
}

/** Route of a request's view. */
export function requestPath(r: Pick<RequestItem, "node" | "conversationId">): string {
  return `/requests/${r.node ?? "home"}/${r.conversationId}`;
}

/** Sidebar entry with the number of open requests (hidden while there are none). */
export function MessageRequestsLink() {
  const t = useT();
  const { closeNav } = useShell();
  const requests = useMessageRequests();
  const count = requests.data?.length ?? 0;
  if (!count) return null;
  return (
    <NavLink to="/requests" onClick={closeNav} data-testid="requests-link" className={({ isActive }) => `mt-1 flex min-h-10 items-center gap-2 rounded-md px-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
      <span aria-hidden="true" className="w-5 text-center">
        ✉
      </span>
      <span className="flex-1">{t("requests.title")}</span>
      <span className="rounded-full bg-accent px-1.5 text-xs text-accent-text" data-testid="requests-count">
        {count}
      </span>
    </NavLink>
  );
}

/** Accept / decline / decline and block, for a list entry or the opened request. */
export function useRequestActions() {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["requests"] }), queryClient.invalidateQueries({ queryKey: ["pending-invites"] }), queryClient.invalidateQueries({ queryKey: ["conversations"] })]);
  const client = async (r: RequestItem) => {
    if (r.node) await connectNode(r.node);
    return apiFor(r.node);
  };
  return {
    accept: async (r: RequestItem) => {
      try {
        const c = await (await client(r)).requests.accept(r.conversationId);
        await indexConversation(r.node, c.kind, c.id, c.kind === "dm" ? r.from : null);
        if (r.inviteId) await api.users.dismissInvite(r.inviteId).catch(() => undefined);
        await refresh();
        useToasts.getState().push({ kind: "info", title: t("requests.accepted") });
        navigate(conversationPath(r.node, c.id));
      } catch (e) {
        toastError(e);
      }
    },
    decline: async (r: RequestItem, block: { reason: string } | null) => {
      try {
        // The block lives on the home node (also for senders of other nodes).
        await (await client(r)).requests.decline(r.conversationId, { block: !!block && !r.node, reason: block?.reason || null });
        if (block && r.node) await api.blocks.block(r.from, block.reason || null);
        if (r.inviteId) await api.users.dismissInvite(r.inviteId).catch(() => undefined);
        await refresh();
        if (block) void queryClient.invalidateQueries({ queryKey: ["blocks"] });
        useToasts.getState().push({ kind: "info", title: t("requests.declined") });
        navigate("/requests");
      } catch (e) {
        toastError(e);
      }
    },
  };
}

/** The decline-and-block dialog with the private note. */
export function BlockReasonDialog({ open, title, onClose, onConfirm }: { open: boolean; title: string; onClose: () => void; onConfirm: (reason: string) => void }) {
  const t = useT();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={title} open={open} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim());
          setReason("");
        }}
      >
        <Field label={t("friends.block_reason")} hint={t("friends.block_reason_hint")}>
          <Input name="block_reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={NOTE_MAX} autoFocus />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" data-testid="block-confirm">
            {t("friends.block")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The buttons of a request. */
export function RequestActions({ request }: { request: RequestItem }) {
  const t = useT();
  const actions = useRequestActions();
  const [blocking, setBlocking] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => void actions.accept(request)} data-testid="request-accept">
        {t("requests.accept")}
      </Button>
      <Button variant="ghost" onClick={() => void actions.decline(request, null)} data-testid="request-decline">
        {t("requests.decline")}
      </Button>
      <Button variant="ghost" onClick={() => setBlocking(true)} data-testid="request-block">
        {t("requests.block")}
      </Button>
      <BlockReasonDialog
        open={blocking}
        title={t("friends.block_reason_title", { address: request.from })}
        onClose={() => setBlocking(false)}
        onConfirm={(reason) => {
          setBlocking(false);
          void actions.decline(request, { reason });
        }}
      />
    </div>
  );
}
