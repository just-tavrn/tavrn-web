// SPDX-License-Identifier: Apache-2.0
// A forced sign-out (the home node refuses the refresh token, e.g. after the device was removed elsewhere) cleans up
// like an explicit one: federated sessions are ended and forgotten, cached queries and per-account browser data go,
// and a session of another account never inherits federated sessions of the previous one.
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResponse, UserPrivate } from "@tavrn/sdk";
import { refreshHome } from "../lib/api";
import { queryClient } from "../lib/queryClient";
import { useAuth } from "./auth";
import { connectNode, nodeDeps, resetNodeCaches, useNodes, type FederatedSession } from "./nodes";
import { mockFetch } from "../test/render";

const userA = { id: "ua", username: "alice", address: "alice@home.test", domain: "home.test" } as unknown as UserPrivate;
const userB = { id: "ub", username: "bob", address: "bob@home.test", domain: "home.test" } as unknown as UserPrivate;
const fedA: FederatedSession = { domain: "far.test", base: "https://far.test", ws: "wss://far.test/ws", web: "https://far.test", token: "A-access-on-far", refresh: "A-refresh-on-far", deviceId: "devA", user: { ...userA, id: "far-ua" } as UserPrivate, expiresAt: Date.now() + 6 * 24 * 3600_000 } as FederatedSession;
const session = (user: UserPrivate, device: string) => ({ access_token: `${user.username}-1`, refresh_token: `${user.username}-r`, user, device_id: device, reauth_token: null }) as unknown as AuthResponse;
const refused = { status: 401, body: { type: "x", title: "Unauthorized", status: 401, code: "auth.refresh_invalid", detail: "" } };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("sign-out cleanup", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNodeCaches();
    useNodes.getState().clear();
    queryClient.clear();
  });

  it("a refused home refresh token ends and forgets the federated sessions", async () => {
    useAuth.getState().setSession(session(userA, "devA"));
    useNodes.getState().put(fedA);
    const calls = mockFetch({ "/auth/refresh": refused, "far.test/api/v1/auth/logout": { status: 204, body: null } });

    expect(await refreshHome()).toBeNull();
    expect(useAuth.getState().user).toBeNull();
    expect(useNodes.getState().sessions).toEqual({});
    expect(localStorage.getItem("tavrn.nodes") ?? "").not.toContain("A-refresh-on-far");
    await flush();
    // Best effort: the session on the other node is ended with its own token.
    const logout = calls.find((c) => c.url.includes("far.test") && c.url.includes("/auth/logout"));
    expect(new Headers(logout?.init.headers).get("authorization")).toBe("Bearer A-access-on-far");
  });

  it("the next account never uses the previous account's federated sessions", async () => {
    useAuth.getState().setSession(session(userA, "devA"));
    useNodes.getState().put(fedA);
    mockFetch({ "/auth/refresh": refused });
    await refreshHome();
    useAuth.getState().setSession(session(userB, "devB"));
    nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/ws`, web: `https://${domain}` });
    mockFetch({ "/federation/token": { body: { token: "fed-B" } }, "/auth/federated": { status: 403, body: { type: "x", title: "no", status: 403, code: "auth.denied", detail: "" } } });
    await expect(connectNode("far.test")).rejects.toBeTruthy();
    expect(useNodes.getState().sessions["far.test"]).toBeUndefined();
  });

  it("a session of another account drops stored federated sessions of the previous one", () => {
    useAuth.getState().setSession(session(userA, "devA"));
    useNodes.getState().put(fedA);
    useNodes.getState().put({ ...fedA, domain: "mine.test", deviceId: "devB", user: { ...userB, id: "m-ub" } as UserPrivate });
    useAuth.getState().setSession(session(userB, "devB"));
    expect(Object.keys(useNodes.getState().sessions)).toEqual(["mine.test"]);
  });

  it("sign-out empties the query cache and removes the account's browser data", async () => {
    useAuth.getState().setSession(session(userA, "devA"));
    queryClient.setQueryData(["rooms"], [{ id: "r1", name: "secret room" }]);
    for (const k of ["tavrn.rail", "tavrn.legal.seen", "tavrn.terms.dismissed", "tavrn.push", "tavrn.notify.entries"]) localStorage.setItem(`${k}:alice@home.test`, "x");
    localStorage.setItem("tavrn.closed-dms", '{"d1":"m1"}');
    localStorage.setItem("tavrn.locale", "de");
    mockFetch({ "/auth/refresh": refused });
    await refreshHome();
    expect(queryClient.getQueryData(["rooms"])).toBeUndefined();
    expect(Object.keys(localStorage).filter((k) => k.includes("alice@home.test") || k === "tavrn.closed-dms")).toEqual([]);
    // Device settings stay.
    expect(localStorage.getItem("tavrn.locale")).toBe("de");
  });
});
