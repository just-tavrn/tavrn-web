// SPDX-License-Identifier: Apache-2.0
// On every connection of the home socket the own account is taken over from `GET /users/me`: an avatar set on another
// device while this client was closed reaches the account bar (tavrn-web#193).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPrivate } from "@tavrn/sdk";
import { refreshOwnProfile } from "./useRealtime";
import { useAuth } from "../stores/auth";

const stored = { id: "me", username: "me", address: "me@home.test", domain: "home.test", display_name: "Me", avatar: null, avatar_still: null, is_node_admin: false } as unknown as UserPrivate;
const client = (me: Partial<UserPrivate> | Error) => ({ users: { me: vi.fn(async () => (me instanceof Error ? Promise.reject(me) : ({ ...stored, ...me }) as UserPrivate)) } }) as never;

describe("refreshOwnProfile", () => {
  // Signed in: the session in memory and in the storage of every tab.
  beforeEach(() => {
    const session = { token: "t", refresh: "r", user: stored, deviceId: "d", home: null };
    localStorage.setItem("tavrn.auth", JSON.stringify(session));
    useAuth.setState(session);
  });
  afterEach(() => {
    localStorage.removeItem("tavrn.auth");
    useAuth.setState({ token: null, refresh: null, user: null, deviceId: null });
  });

  it("takes over the avatar the home node has now", async () => {
    await refreshOwnProfile(client({ avatar: "/media/a.webp", avatar_still: "/media/a-still.webp", display_name: "Daniel" }));
    expect(useAuth.getState().user).toMatchObject({ id: "me", avatar: "/media/a.webp", avatar_still: "/media/a-still.webp", display_name: "Daniel" });
  });

  it("ignores another account and a failed request", async () => {
    await refreshOwnProfile(client({ id: "someone-else", avatar: "/media/x.webp" }));
    expect(useAuth.getState().user?.avatar).toBeNull();
    await refreshOwnProfile(client(new Error("offline")));
    expect(useAuth.getState().user).toMatchObject({ id: "me", avatar: null });
  });
});
