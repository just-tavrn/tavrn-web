// SPDX-License-Identifier: Apache-2.0
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { createStore, useStore, type StoreApi } from "zustand";
import type { Message, Profile } from "@tavrn/sdk";
import { ProfileCard } from "./ProfilePopover";
import { useNode } from "./NodeScope";

/** Absolute URLs of an author's avatar on the node of the conversation (design note 4.9). */
export interface AuthorAvatar {
  still: string | null;
  animated: string | null;
}

type AvatarMap = Record<string, AuthorAvatar>;
export type AuthorAvatarStore = StoreApi<AvatarMap>;

const AuthorAvatarContext = createContext<AuthorAvatarStore | null>(null);
/** Outside an {@link AuthorProfiles} (tests, previews) there are no images: initials. */
const EMPTY_STORE: AuthorAvatarStore = createStore<AvatarMap>(() => ({}));

export function createAuthorAvatarStore(initial: AvatarMap = {}): AuthorAvatarStore {
  return createStore<AvatarMap>(() => initial);
}

/**
 * Merges `next` into the store, keeping the entry objects of unchanged authors: a row subscribes to its
 * author's entry only, so a profile change re-renders the avatars of that author and nothing else.
 */
export function mergeAuthorAvatars(store: AuthorAvatarStore, next: AvatarMap): void {
  const current = store.getState();
  let changed = false;
  const merged: AvatarMap = { ...current };
  for (const [address, a] of Object.entries(next)) {
    const old = current[address];
    if (old && old.still === a.still && old.animated === a.animated) continue;
    merged[address] = a;
    changed = true;
  }
  if (changed) store.setState(merged, true);
}

/** The avatar of `address` (undefined: unknown so far, show the initials). */
export function useAuthorAvatar(address: string): AuthorAvatar | undefined {
  const store = useContext(AuthorAvatarContext) ?? EMPTY_STORE;
  return useStore(store, (s) => s[address]);
}

/** Only for tests and previews: rows below see the avatars of `store`. */
export function AuthorAvatarProvider({ store, children }: { store: AuthorAvatarStore; children: ReactNode }) {
  return <AuthorAvatarContext.Provider value={store}>{children}</AuthorAvatarContext.Provider>;
}

/**
 * Loads the profiles of the authors of `messages` from the node of the current scope (the same queries
 * and cache as the profile card, so `user.update` refreshes them) and publishes their avatar URLs to the
 * rows below. Changes reach only the avatars of the changed author, never the whole list.
 */
function useAuthorAvatarStore(messages: Message[]): AuthorAvatarStore {
  const scoped = useNode();
  const [store] = useState(() => createAuthorAvatarStore());
  // Distinct authors, as a stable key: a new message of a known author changes nothing here.
  const key = useMemo(() => [...new Set(messages.map((m) => m.author))].sort().join("\n"), [messages]);
  const authors = useMemo(() => (key ? key.split("\n") : []), [key]);
  const avatars = useQueries({
    queries: authors.map((address) => ({
      queryKey: ["profile", scoped.domain, address],
      queryFn: () => scoped.api.users.profile(address),
      staleTime: 30_000,
      retry: false,
    })),
    combine: (results) => results.map((r) => r.data as Profile | undefined),
  });
  useEffect(() => {
    const next: AvatarMap = {};
    avatars.forEach((profile, i) => {
      if (!profile) return;
      const still = scoped.api.mediaUrl(profile.avatar_still);
      const full = scoped.api.mediaUrl(profile.avatar);
      next[authors[i]!] = { still, animated: full && full !== still ? full : null };
    });
    mergeAuthorAvatars(store, next);
  }, [avatars, authors, scoped.api, store]);
  return store;
}

/**
 * Opens the profile card on a click on a message author's avatar or name (design note 4.9) and provides the
 * authors' avatars to the rows. The message list renders authors without handlers; this wrapper
 * (`display: contents`, no layout of its own) finds the clicked message by its `data-message-id` and the
 * author by the avatar button or the name in the header.
 */
export function AuthorProfiles({ messages, children }: { messages: Message[]; children: ReactNode }) {
  const store = useAuthorAvatarStore(messages);
  const [open, setOpen] = useState<{ address: string; anchor: DOMRect } | null>(null);
  const onClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>("[data-message-id]");
      if (!item) return;
      const avatar = target.closest<HTMLElement>('[data-testid="message-avatar"]');
      // The name in the message header carries `data-author-name` (MessageList), independent of its styling.
      const name = target.closest<HTMLElement>("[data-author-name]");
      const isName = !!name && item.contains(name);
      if (!(avatar && item.contains(avatar)) && !isName) return;
      const m = messages.find((x) => x.id === item.dataset.messageId);
      if (!m) return;
      // Join/leave entries (welcome channel) name the member on the avatar.
      setOpen({ address: avatar?.dataset.address ?? m.author, anchor: (avatar ?? name ?? target).getBoundingClientRect() });
    },
    [messages],
  );
  return (
    <div className="contents" onClick={onClick} data-author-profiles>
      <AuthorAvatarContext.Provider value={store}>{children}</AuthorAvatarContext.Provider>
      {open && <ProfileCard address={open.address} anchor={open.anchor} onClose={() => setOpen(null)} />}
    </div>
  );
}
