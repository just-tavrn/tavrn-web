// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { TavrnApiError, type PendingInvite } from "@tavrn/sdk";
import { api } from "../lib/api";
import { acceptInvite } from "../lib/invites";
import { useT } from "../i18n";
import { toastError } from "../stores/toasts";
import { Avatar, Button } from "./ui";
import { ViaNode, viaOf } from "./ViaNode";

/** The invite list of the home node (null while the node has none: 404 before federation step 4). */
export function usePendingInvites() {
  return useQuery({
    queryKey: ["pending-invites"],
    queryFn: async () => {
      try {
        return (await api.users.invites()).items;
      } catch (e) {
        if (e instanceof TavrnApiError && (e.status === 404 || e.status === 405)) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Pending invitations to rooms and conversations of any node (FEDERATION.md §4), live via `room.invite`
 * and `conversation.invite`. The node and the inviter's full address are always shown (design note 9d).
 */
export function InviteList() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invites = usePendingInvites();
  const [busy, setBusy] = useState<string | null>(null);
  // Message requests of other nodes are listed under "Message requests" (components/MessageRequests.tsx).
  const items = (invites.data ?? []).filter((i) => !(i.kind === "conversation" && (i.conversation as { requested?: boolean } | null | undefined)?.requested));
  if (!items.length) return null;
  const done = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["pending-invites"] }), queryClient.invalidateQueries({ queryKey: ["rooms"] }), queryClient.invalidateQueries({ queryKey: ["conversations"] })]);
  const dismiss = async (invite: PendingInvite) => {
    try {
      await api.users.dismissInvite(invite.id);
      await queryClient.invalidateQueries({ queryKey: ["pending-invites"] });
    } catch (e) {
      toastError(e);
    }
  };
  const accept = async (invite: PendingInvite) => {
    setBusy(invite.id);
    try {
      const path = await acceptInvite(invite);
      await done();
      navigate(path);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-fg-2">{t("home.invites")}</h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="invite-list">
        {items.map((i) => {
          const name = i.room?.name ?? i.conversation?.name ?? (i.kind === "conversation" ? t(i.conversation?.kind === "dm" ? "home.invite_dm" : "home.invite_group") : t("home.invite_unnamed"));
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-bg-1 p-3" data-testid="invite" data-kind={i.kind} data-node={i.node}>
              <Avatar name={name} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{name}</p>
                {/* Full addresses and the node domain at security-relevant spots (design note 9d). */}
                <p className="truncate text-xs text-fg-2">
                  {t("home.invite_from", { inviter: i.inviter, node: i.node })}
                  {viaOf(i) && (
                    <>
                      {" "}
                      <ViaNode node={viaOf(i)!} />
                    </>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <Button disabled={busy === i.id} onClick={() => void accept(i)}>
                  {t("home.invite_accept")}
                </Button>
                <Button variant="ghost" disabled={busy === i.id} onClick={() => void dismiss(i)}>
                  {t("home.invite_dismiss")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
