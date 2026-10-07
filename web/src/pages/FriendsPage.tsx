// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { User } from "@tavrn/sdk";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { describeError, toastError } from "../stores/toasts";
import { Button } from "../components/ui";
import { UserLine, openDm, useFriends } from "./DirectMessages";
import { FriendRequestForm } from "../components/FriendRequestForm";
import { BlockReasonDialog } from "../components/MessageRequests";
import { BlockedUsersList } from "./settings/PrivacyTab";

/** Friends, incoming and outgoing requests and blocked users (PROTOCOL.md §8a), live via `friend.*`. */
export function FriendsPage() {
  const t = useT();
  const friends = useFriends();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["friends"] });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };
  const message = async (user: User) => {
    try {
      // An existing DM on any node (e.g. one the friend started on their home node), else a new one here.
      navigate(await openDm(user.address, queryClient));
    } catch (e) {
      toastError(e);
    }
  };
  const [blocking, setBlocking] = useState<User | null>(null);
  const block = (user: User) => setBlocking(user);
  const data = friends.data;
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <h1 className="text-xl font-semibold">{t("friends.title")}</h1>
      <div className="mt-4">
        <FriendRequestForm />
      </div>
      {friends.isError && <p className="mt-4 text-sm text-danger">{describeError(friends.error)}</p>}
      {data && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <FriendSection title={t("friends.incoming")} empty={t("friends.none")} testId="friends-incoming" items={data.incoming.map((r) => ({ key: r.id, user: r.user, note: r.message, actions: (
            <>
              <Button onClick={() => void act(() => api.friends.accept(r.id))}>{t("friends.accept")}</Button>
              <Button variant="ghost" onClick={() => void act(() => api.friends.deleteRequest(r.id))}>
                {t("friends.decline")}
              </Button>
              <Button variant="ghost" onClick={() => block(r.user)}>
                {t("friends.block")}
              </Button>
            </>
          ) }))} />
          <FriendSection title={t("friends.outgoing")} empty={t("friends.none")} testId="friends-outgoing" items={data.outgoing.map((r) => ({ key: r.id, user: r.user, note: r.message, actions: (
            <Button variant="ghost" onClick={() => void act(() => api.friends.deleteRequest(r.id))}>
              {t("friends.withdraw")}
            </Button>
          ) }))} />
          <FriendSection title={t("friends.friends")} empty={t("friends.no_friends")} testId="friends-list" items={data.friends.map((f) => ({ key: f.user.id, user: f.user, actions: (
            <>
              <Button onClick={() => void message(f.user)}>{t("friends.message")}</Button>
              <Button variant="ghost" onClick={() => confirm(t("friends.remove_confirm", { address: f.user.address })) && void act(() => api.friends.remove(f.user.address))}>
                {t("friends.remove")}
              </Button>
              <Button variant="ghost" onClick={() => block(f.user)}>
                {t("friends.block")}
              </Button>
            </>
          ) }))} />
          <div data-testid="friends-blocked">
            <BlockedUsersList />
          </div>
        </div>
      )}
      <BlockReasonDialog
        open={!!blocking}
        title={t("friends.block_reason_title", { address: blocking?.address ?? "" })}
        onClose={() => setBlocking(null)}
        onConfirm={(reason) => {
          const user = blocking;
          setBlocking(null);
          if (user) void act(() => api.blocks.block(user.address, reason || null)).then(() => queryClient.invalidateQueries({ queryKey: ["blocks"] }));
        }}
      />
    </div>
  );
}

function FriendSection({ title, empty, items, testId }: { title: string; empty: string; testId: string; items: { key: string; user: User; note?: string | null; actions: React.ReactNode }[] }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-2">
        {title} – {items.length}
      </h2>
      {items.length === 0 && <p className="mt-2 text-sm text-fg-2">{empty}</p>}
      <ul className="mt-2 space-y-2" data-testid={testId}>
        {items.map((i) => (
          <li key={i.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-1 p-3">
            {/* The name keeps at least 14rem; the actions wrap below when the column is narrow. */}
            <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
              <UserLine user={i.user} />
              {i.note && (
                <p className="mt-1 break-words text-sm text-fg-1" data-testid="friend-request-message">
                  “{i.note}”
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1">{i.actions}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
