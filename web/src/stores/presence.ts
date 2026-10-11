// SPDX-License-Identifier: Apache-2.0
/**
 * Presence of other users and of the own account (design note 4.9). Every node with a session reports the
 * presences it knows (`GET /presence`, `presence.update`); they are kept by address, so a user known on
 * several nodes has one entry (the client pushes the same state everywhere, the views agree). Users
 * without an entry are offline.
 */
import { create } from "zustand";
import type { Activity, CustomStatus, MyPresence, Presence } from "@tavrn/sdk";

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible" | "offline";
/** Statuses the user can choose (`idle` is set by the client after inactivity). */
export const CHOSEN_STATUSES = ["online", "idle", "dnd", "invisible"] as const;

interface PresenceState {
  /** By address. */
  users: Record<string, Presence>;
  /** The own presence as the home node reports it. */
  mine: MyPresence | null;
  /** The own status before the client set `idle` automatically (restored on activity). */
  autoIdle: boolean;
  apply: (p: Presence) => void;
  seed: (list: Presence[]) => void;
  setMine: (m: MyPresence | null) => void;
  setAutoIdle: (v: boolean) => void;
  clear: () => void;
}

export const usePresence = create<PresenceState>((set) => ({
  users: {},
  mine: null,
  autoIdle: false,
  apply: (p) => set((s) => ({ users: applyPresence(s.users, p) })),
  seed: (list) => set((s) => ({ users: list.reduce(applyPresence, s.users) })),
  setMine: (mine) => set({ mine }),
  setAutoIdle: (autoIdle) => set({ autoIdle }),
  clear: () => set({ users: {}, mine: null, autoIdle: false }),
}));

/** Adds or replaces a presence; `offline` removes the entry. */
export function applyPresence(users: Record<string, Presence>, p: Presence): Record<string, Presence> {
  if (p.status === "offline") {
    if (!(p.user in users)) return users;
    const { [p.user]: _gone, ...rest } = users;
    return rest;
  }
  return { ...users, [p.user]: p };
}

/** Whether typing indicators may be sent: not while the user appears offline (`invisible`). */
export function sendsTyping(mine: MyPresence | null): boolean {
  return mine?.status !== "invisible" && mine?.effective !== "invisible";
}

/** The effective status of `address` (the own account shows the true status, incl. `invisible`). */
export function statusOf(users: Record<string, Presence>, address: string | undefined, mine?: { address: string; presence: MyPresence | null }): PresenceStatus {
  if (!address) return "offline";
  if (mine && mine.address === address && mine.presence) return mine.presence.effective as PresenceStatus;
  return ((users[address]?.status as PresenceStatus | undefined) ?? "offline");
}

/** A custom status unless it expired. */
export function activeCustom(c: CustomStatus | null | undefined, now = Date.now()): CustomStatus | null {
  if (!c) return null;
  if (c.expires_at && Date.parse(c.expires_at) <= now) return null;
  return c;
}

/** The line under a name: custom status, else the activity ("Playing Factorio"). */
export function statusLine(p: Pick<Presence, "custom_status" | "activity"> | null | undefined, activityLabel: (a: Activity) => string): string | null {
  const custom = activeCustom(p?.custom_status);
  if (custom) return [custom.emoji, custom.text].filter(Boolean).join(" ");
  if (p?.activity) return activityLabel(p.activity);
  return null;
}

/** Tailwind classes of the presence dot. */
export const DOT_CLASS: Record<PresenceStatus, string> = {
  online: "bg-ok",
  idle: "bg-warn",
  dnd: "bg-danger-solid",
  invisible: "bg-fg-2",
  offline: "bg-fg-2",
};

/** Hook: the status of one user. */
export function useStatus(address: string | undefined, meAddress?: string): PresenceStatus {
  return usePresence((s) => statusOf(s.users, address, meAddress ? { address: meAddress, presence: s.mine } : undefined));
}
