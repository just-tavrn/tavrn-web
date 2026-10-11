// SPDX-License-Identifier: Apache-2.0
// Every path that ends the home session cleans up federated sessions, the query cache and account storage.
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResponse, UserPrivate } from "@tavrn/sdk";
import { queryClient } from "../lib/queryClient";
import { useAuth } from "./auth";
import { resetNodeCaches, useNodes, type FederatedSession } from "./nodes";
import { mockFetch } from "../test/render";

const userA = {
  id: "ua",
  username: "alice",
  address: "alice@home.test",
  domain: "home.test",
} as unknown as UserPrivate;
const userB = {
  id: "ub",
  username: "bob",
  address: "bob@home.test",
  domain: "home.test",
} as unknown as UserPrivate;
const fedA: FederatedSession = {
  domain: "far.test",
  base: "https://far.test",
  ws: "wss://far.test/ws",
  web: "https://far.test",
  token: "A-access-on-far",
  refresh: "A-refresh-on-far",
  deviceId: "devA",
  user: { ...userA, id: "far-ua" } as UserPrivate,
  expiresAt: Date.now() + 6 * 24 * 3600_000,
} as FederatedSession;
const session = (user: UserPrivate, device: string) =>
  ({
    access_token: `${user.username}-1`,
    refresh_token: `${user.username}-r`,
    user,
    device_id: device,
    reauth_token: null,
  }) as unknown as AuthResponse;

function seed() {
  useAuth.getState().setSession(session(userA, "devA"));
  useNodes.getState().put(fedA);
  queryClient.setQueryData(["rooms"], [{ id: "r1" }]);
  localStorage.setItem("tavrn.rail:alice@home.test", "x");
}
function expectClean() {
  expect(useNodes.getState().sessions).toEqual({});
  expect(localStorage.getItem("tavrn.nodes") ?? "").not.toContain(
    "A-refresh-on-far",
  );
  expect(queryClient.getQueryData(["rooms"])).toBeUndefined();
  expect(localStorage.getItem("tavrn.rail:alice@home.test")).toBeNull();
}

describe("every sign-out path cleans up", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNodeCaches();
    useNodes.getState().clear();
    queryClient.clear();
    mockFetch({});
  });

  it("explicit logout (also the socket's auth failure handler)", () => {
    seed();
    useAuth.getState().logout();
    expectClean();
  });

  it("another tab signed out", () => {
    seed();
    localStorage.setItem(
      "tavrn.auth",
      JSON.stringify({
        token: null,
        refresh: null,
        user: null,
        deviceId: null,
        home: null,
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "tavrn.auth" }));
    expect(useAuth.getState().user).toBeNull();
    expectClean();
  });

  it("another tab signed in with another account", () => {
    seed();
    localStorage.setItem(
      "tavrn.auth",
      JSON.stringify({
        token: "b",
        refresh: "rb",
        user: userB,
        deviceId: "devB",
        home: null,
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "tavrn.auth" }));
    expect(useAuth.getState().user?.address).toBe("bob@home.test");
    expectClean();
  });
});
