// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApi, type UserPrivate } from "@tavrn/sdk";
import { api } from "../lib/api";
import { useAuth } from "./auth";
import { useReach } from "./reach";
import { RENEW_BEFORE_MS, apiFor, connectNode, homeKeys, isHome, meOn, nodeDeps, renewExpiring, resetNodeCaches, signOutNodes, useNodes } from "./nodes";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-04T12:00:00Z");

function user(domain: string, id: string): UserPrivate {
  return { id, username: "alice", domain, address: `alice@${domain}`, display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } as UserPrivate;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
  url: string;
  method: string;
  auth?: string;
  body: unknown;
}

/** Fake nodes: a.test (home) issues federation tokens, b.test accepts them. */
function fakeNetwork(opts: { expiresIn?: number; down?: Set<string>; refuse?: { code: string | null } } = {}) {
  const calls: Call[] = [];
  let logins = 0;
  let refreshes = 0;
  const validTokens = new Set<string>();
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.Authorization, body });
    const host = new URL(url).hostname;
    if (opts.down?.has(host)) throw new TypeError("Failed to fetch");
    if (url === "https://a.test/api/v1/federation/token") return json(200, { token: `fed-${calls.length}`, target: body.target, expires_in: 600 });
    if (url.includes("/keys") && url.includes("/api/v1/users/")) return json(200, { user: decodeURIComponent(url.split("/users/")[1]!.split("/")[0]!), identity_public_key: "KEY", identity_reset_at: null, devices: [] });
    if (url === "https://b.test/api/v1/auth/federated" && opts.refuse?.code) return json(403, { type: "x", title: "", status: 403, detail: "", code: opts.refuse.code });
    if (url === "https://b.test/api/v1/auth/federated") {
      logins++;
      const token = `b-access-${logins}`;
      validTokens.add(token);
      return json(200, { status: "ok", user: user("a.test", "B-LOCAL-ID"), access_token: token, refresh_token: `b-refresh-${logins}`, expires_in: 3600, device_id: "HOME-DEVICE", recovery_code_used: false, session_expires_at: new Date(NOW + (opts.expiresIn ?? 7 * DAY)).toISOString() });
    }
    if (url === "https://b.test/api/v1/auth/refresh") {
      refreshes++;
      if (body.refresh_token === "dead") return json(401, { type: "x", title: "", status: 401, detail: "", code: "auth.refresh_invalid" });
      const token = `b-refreshed-${refreshes}`;
      validTokens.add(token);
      return json(200, { access_token: token, refresh_token: `b-refresh-r${refreshes}`, expires_in: 3600, device_id: "HOME-DEVICE" });
    }
    if (url === "https://b.test/api/v1/rooms") {
      const token = headers.Authorization?.replace("Bearer ", "") ?? "";
      if (!validTokens.has(token)) return json(401, { type: "x", title: "", status: 401, detail: "", code: "auth.token_expired" });
      return json(200, [{ id: "ROOM-B", name: "Lounge" }]);
    }
    if (url.endsWith("/auth/logout")) return new Response(null, { status: 204 });
    return json(404, { type: "x", title: "", status: 404, detail: url, code: "route.not_found" });
  });
  vi.stubGlobal("fetch", impl);
  return { calls, logins: () => logins, refreshes: () => refreshes, validTokens };
}

beforeEach(() => {
  localStorage.clear();
  resetNodeCaches();
  useNodes.setState({ sessions: {}, failed: {} });
  useReach.setState({ nodes: {} });
  useAuth.setState({ token: "home-token", refresh: "home-refresh", user: user("a.test", "A-ID"), deviceId: "HOME-DEVICE", home: { domain: "a.test", base: "https://a.test", ws: "wss://a.test/api/v1/ws" } });
  nodeDeps.now = () => NOW;
  nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/api/v1/ws`, web: `https://${domain}` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("federated sessions", () => {
  it("logs in with a federation token of the home node and keeps the session", async () => {
    const net = fakeNetwork();
    const s = await connectNode("b.test");
    expect(s.token).toBe("b-access-1");
    expect(s.deviceId).toBe("HOME-DEVICE");
    expect(s.user.id).toBe("B-LOCAL-ID");
    expect(net.calls[0]).toMatchObject({ url: "https://a.test/api/v1/federation/token", auth: "Bearer home-token", body: { target: "b.test" } });
    expect(net.calls[1]).toMatchObject({ url: "https://b.test/api/v1/auth/federated", body: { token: "fed-1", device_name: "Browser" } });
    expect(JSON.parse(localStorage.getItem("tavrn.nodes")!)["b.test"].token).toBe("b-access-1");
    // Cached afterwards; concurrent callers share one login.
    await Promise.all([connectNode("b.test"), connectNode("b.test")]);
    expect(net.logins()).toBe(1);
    expect(meOn("b.test")?.id).toBe("B-LOCAL-ID");
    expect(meOn("a.test")?.id).toBe("A-ID");
  });

  it("renews before the 7-day cap", async () => {
    const net = fakeNetwork({ expiresIn: RENEW_BEFORE_MS - 1000 });
    await connectNode("b.test");
    await connectNode("b.test");
    expect(net.logins()).toBe(2);
    nodeDeps.now = () => NOW - DAY * 3; // plenty left from this point of view
    await connectNode("b.test");
    expect(net.logins()).toBe(2);
    nodeDeps.now = () => NOW;
    await renewExpiring();
    expect(net.logins()).toBe(3);
  });

  it("refreshes on 401 and falls back to a new federated login", async () => {
    const net = fakeNetwork();
    await connectNode("b.test");
    net.validTokens.clear(); // the access token expired
    expect(await apiFor("b.test").rooms.list()).toEqual([{ id: "ROOM-B", name: "Lounge" }]);
    expect(net.refreshes()).toBe(1);
    expect(useNodes.getState().sessions["b.test"]!.token).toBe("b-refreshed-1");

    net.validTokens.clear();
    useNodes.getState().update("b.test", { refresh: "dead" }); // e.g. revoked or past the cap
    await apiFor("b.test").rooms.list();
    expect(net.logins()).toBe(2);
    expect(useNodes.getState().sessions["b.test"]!.token).toBe("b-access-2");
  });

  it("routes API calls by node", async () => {
    const net = fakeNetwork();
    expect(apiFor("a.test")).toBe(api);
    expect(apiFor(null)).toBe(api);
    expect(isHome("a.test")).toBe(true);
    expect(isHome("b.test")).toBe(false);
    await connectNode("b.test");
    const b = apiFor("b.test");
    expect(b).toBeInstanceOf(TavrnApi);
    expect(b.baseUrl).toBe("https://b.test");
    await b.rooms.list();
    expect(net.calls.at(-1)).toMatchObject({ url: "https://b.test/api/v1/rooms", auth: "Bearer b-access-1" });
    await expect(connectNode("a.test")).rejects.toThrow();
  });

  it("marks only the failing node unreachable, and reachable again on the next answer", async () => {
    const down = new Set<string>();
    fakeNetwork({ down });
    await connectNode("b.test");
    expect(useReach.getState().nodes["b.test"]).toBe("ok");
    down.add("b.test");
    await expect(apiFor("b.test").rooms.list()).rejects.toMatchObject({ code: "network.error" });
    expect(useReach.getState().nodes["b.test"]).toBe("unreachable");
    await api.request("GET", "/users/me").catch(() => undefined);
    expect(useReach.getState().nodes["a.test"]).toBe("ok");
    down.delete("b.test");
    await apiFor("b.test").rooms.list();
    expect(useReach.getState().nodes["b.test"]).toBe("ok");
  });

  it("signs out of every node", async () => {
    const net = fakeNetwork();
    await connectNode("b.test");
    await signOutNodes();
    expect(net.calls.at(-1)).toMatchObject({ url: "https://b.test/api/v1/auth/logout", auth: "Bearer b-access-1" });
    expect(useNodes.getState().sessions).toEqual({});
    expect(localStorage.getItem("tavrn.nodes")).toBe("{}");
  });
});

describe("keys of other users (FEDERATION.md §3.5)", () => {
  it("asks the user's home node: the home client for this node, the public route of any other node", async () => {
    const net = fakeNetwork();
    await connectNode("b.test");
    expect((await homeKeys("alice@a.test")).user).toBe("alice@a.test");
    expect(net.calls.at(-1)).toMatchObject({ url: "https://a.test/api/v1/users/alice%40a.test/keys", auth: "Bearer home-token" });
    // carol lives on c.test: b.test (where a conversation may be hosted) is never asked, and no session is sent.
    expect((await homeKeys("carol@c.test")).user).toBe("carol@c.test");
    expect(net.calls.at(-1)).toMatchObject({ url: "https://c.test/api/v1/users/carol%40c.test/keys", auth: undefined });
    expect(net.calls.some((c) => c.url.startsWith("https://b.test/") && c.url.includes("/keys"))).toBe(false);
  });

  it("rejects addresses without a valid node domain before any request", async () => {
    const net = fakeNetwork();
    for (const bad of ["carol", "@c.test", "carol@", "carol@localhost:8080", "carol@evil.example/x"]) {
      await expect(homeKeys(bad)).rejects.toMatchObject({ code: "user.not_found" });
    }
    expect(net.calls).toEqual([]);
  });
});

describe("renewal failures", () => {
  it("asks to sign in again only on the node that refused the session", async () => {
    const refuse = { code: null as string | null };
    const net = fakeNetwork({ refuse });
    await connectNode("b.test");
    net.validTokens.clear();
    useNodes.getState().update("b.test", { refresh: "dead" });
    refuse.code = "federation.user_banned";
    await expect(apiFor("b.test").rooms.list()).rejects.toMatchObject({ status: 401 });
    expect(useNodes.getState().failed).toEqual({ "b.test": "federation.user_banned" });
    // Signing in there again clears it.
    refuse.code = null;
    await connectNode("b.test", { force: true });
    expect(useNodes.getState().failed).toEqual({});
  });

  it("does not ask to sign in again while a node is merely unreachable", async () => {
    const down = new Set<string>();
    fakeNetwork({ down });
    await connectNode("b.test");
    down.add("b.test");
    await expect(connectNode("b.test", { force: true })).rejects.toBeTruthy();
    expect(useNodes.getState().failed).toEqual({});
    expect(useReach.getState().nodes["b.test"]).toBe("unreachable");
  });
});
