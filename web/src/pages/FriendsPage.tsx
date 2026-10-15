// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { User } from "@tavrn/sdk";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { describeError, toastError } from "../stores/toasts";
import { useAction } from "../hooks/useAction";
import { confirmDialog } from "../components/Confirm";
import { Button } from "../components/ui";
import { UserLine, openDm, useFriends } from "./DirectMessages";
import { FriendRequestForm } from "../components/FriendRequestForm";
import { BlockReasonDialog } from "../components/MessageRequests";
import { BlockedUsersList } from "./settings/PrivacyTab";
import { ContextMenu, MenuButton, menuItem, normalizeMenu, separator, useContextMenu } from "../components/ContextMenu";
import { FriendVoiceLine, useFriendVoice } from "../components/FriendVoice";
import { SpeakerIcon } from "../voice/ui/icons";
import { inviteToRoomEntry } from "../lib/menus";
import { sendRoomInvite, useInviteRooms } from "../components/menus/inviteToRoom";

/** Friends, incoming and outgoing requests and blocked users (PROTOCOL.md §8a), live via `friend.*`. */
export function FriendsPage() {
  const t = useT();
  const friends = useFriends();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // One action at a time (a double click sends one request); a failed refetch afterwards is only a warning.
  const { run: act } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["friends"] }) });
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
          <FriendSection title={t("friends.friends")} empty={t("friends.no_friends")} testId="friends-list" items={data.friends.map((f) => {
            const remove = async () => {
              if (await confirmDialog({ text: t("friends.remove_confirm", { address: f.user.address }), confirmLabel: t("friends.remove"), danger: true })) await act(() => api.friends.remove(f.user.address));
            };
            return { key: f.user.id, user: f.user, friend: { message: () => void message(f.user), remove, block: () => block(f.user) }, actions: (
            <>
              <Button onClick={() => void message(f.user)}>{t("friends.message")}</Button>
              <Button variant="ghost" onClick={() => void remove()}>
                {t("friends.remove")}
              </Button>
              <Button variant="ghost" onClick={() => block(f.user)}>
                {t("friends.block")}
              </Button>
            </>
          ) };
          })} />
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
          if (user) void act(() => api.blocks.block(user.address, reason || null), { refresh: () => Promise.all([queryClient.invalidateQueries({ queryKey: ["friends"] }), queryClient.invalidateQueries({ queryKey: ["blocks"] })]) });
        }}
      />
    </div>
  );
}

/** The menu actions of a friend (the same as the buttons, plus joining their voice channel). */
interface FriendActions {
  message: () => void;
  remove: () => void;
  block: () => void;
}

type SectionItem = { key: string; user: User; note?: string | null; actions: React.ReactNode; friend?: FriendActions };

function FriendSection({ title, empty, items, testId }: { title: string; empty: string; testId: string; items: SectionItem[] }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-2">
        {title} – {items.length}
      </h2>
      {items.length === 0 && <p className="mt-2 text-sm text-fg-2">{empty}</p>}
      <ul className="mt-2 space-y-2" data-testid={testId}>
        {items.map((i) => (i.friend ? <FriendItem key={i.key} item={i} friend={i.friend} /> : <ItemRow key={i.key} item={i} />))}
      </ul>
    </section>
  );
}

const ROW = "flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-1 p-3";

function ItemBody({ item, children }: { item: SectionItem; children?: React.ReactNode }) {
  return (
    /* The name keeps at least 14rem; the actions wrap below when the column is narrow. */
    <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
      <UserLine user={item.user} />
      {item.note && (
        <p className="mt-1 break-words text-sm text-fg-1" data-testid="friend-request-message">
          “{item.note}”
        </p>
      )}
      {children}
    </div>
  );
}

function ItemRow({ item }: { item: SectionItem }) {
  return (
    <li className={ROW}>
      <ItemBody item={item} />
      <div className="flex flex-wrap gap-1">{item.actions}</div>
    </li>
  );
}

/**
 * A friend: where they are in voice (only channels the user can view) and a context menu (right-click, long press,
 * the ⋯ button) with "Join <channel>", message, "Invite to room" (the rooms where the user may invite), remove and block.
 */
function FriendItem({ item, friend }: { item: SectionItem; friend: FriendActions }) {
  const t = useT();
  const voice = useFriendVoice(item.user.address);
  const menu = useContextMenu();
  const inviteRooms = useInviteRooms(menu.open);
  const name = item.user.display_name;
  const entries = menu.open
    ? normalizeMenu([
        voice && menuItem("join-voice", t("friends.join_voice", { channel: voice.channelName }), () => void voice.join(), { icon: <SpeakerIcon size={16} />, testId: "friend-join-voice" }),
        voice && separator("sep-voice"),
        menuItem("message", t("friends.message"), friend.message),
        inviteToRoomEntry(inviteRooms, item.user.address, (room) => void sendRoomInvite(room, item.user.address, name), t),
        separator("sep-danger"),
        menuItem("remove", t("friends.remove"), friend.remove, { danger: true }),
        menuItem("block", t("friends.block"), friend.block, { danger: true }),
      ])
    : [];
  return (
    <li className={ROW} data-testid="friend-item" data-user={item.user.address} {...menu.triggerProps}>
      <ItemBody item={item}>{voice && <FriendVoiceLine voice={voice} />}</ItemBody>
      <div className="flex flex-wrap items-center gap-1">
        {item.actions}
        <MenuButton menu={menu} label={t("friends.menu", { name: item.user.display_name })} testId="friend-menu-button" className="min-h-10 min-w-10" />
      </div>
      {menu.open && menu.anchor && <ContextMenu entries={entries} anchor={menu.anchor} onClose={menu.close} label={t("menu.label", { name: item.user.display_name })} testId="friend-menu" />}
    </li>
  );
}
