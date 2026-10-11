// SPDX-License-Identifier: Apache-2.0
// Sign-out races and leftovers found in review: a federated login in flight at sign-out, the in-memory conversation index.
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResponse, UserPrivate } from "@tavrn/sdk";
import { queryClient } from "../lib/queryClient";
import { useAuth } from "./auth";
import {
  connectNode,
  nodeDeps,
  resetNodeCaches,
  useNodes,
  type FederatedSession,
} from "./nodes";
import { mockFetch } from "../test/render";
import { useConversationIndex } from "./conversationIndex";

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
const flush = () => new Promise((r) => setTimeout(r, 0));

function seed() {
  // used by the index test

  useAuth.getState().setSession(session(userA, "devA"));
  useNodes.getState().put(fedA);
  queryClient.setQueryData(["rooms"], [{ id: "r1" }]);
  localStorage.setItem("tavrn.rail:alice@home.test", "x");
}

describe("sign-out races (red until fixed)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNodeCaches();
    useNodes.getState().clear();
    queryClient.clear();
    mockFetch({});
  });

  it("a federated login still in flight when the account signs out is not stored afterwards", async () => {
    useAuth.getState().setSession(session(userA, "devA"));
    nodeDeps.discover = async (domain) => ({
      domain,
      base: `https://${domain}`,
      ws: `wss://${domain}/ws`,
      web: `https://${domain}`,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = mockFetch({
      "/federation/token": { body: { token: "fed-A" } },
    });
    void base;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/auth/federated")) {
        await gate;
        return new Response(
          JSON.stringify({
            access_token: "A-late",
            refresh_token: "A-late-r",
            device_id: "devA",
            user: { ...userA, id: "far-ua" },
            expires_in: 900,
            session_expires_at: new Date(Date.now() + 864e5).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return inner(url, init);
    }) as typeof fetch;
    const p = connectNode("far.test").catch(() => null);
    await flush();
    await flush();
    useAuth.getState().logout();
    release();
    await p;
    await flush();
    expect(localStorage.getItem("tavrn.nodes") ?? "").not.toContain("A-late");
    expect(useNodes.getState().sessions["far.test"]).toBeUndefined();
  });
  it("a federated login of A in flight is not handed to account B signing in meanwhile", async () => {
    useAuth.getState().setSession(session(userA, "devA"));
    nodeDeps.discover = async (domain) => ({
      domain,
      base: `https://${domain}`,
      ws: `wss://${domain}/ws`,
      web: `https://${domain}`,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = mockFetch({
      "/federation/token": { body: { token: "fed-A" } },
    });
    void base;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/auth/federated")) {
        await gate;
        return new Response(
          JSON.stringify({
            access_token: "A-late",
            refresh_token: "A-late-r",
            device_id: "devA",
            user: { ...userA, id: "far-ua" },
            expires_in: 900,
            session_expires_at: new Date(Date.now() + 864e5).toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return inner(url, init);
    }) as typeof fetch;
    const p = connectNode("far.test").catch(() => null);
    await flush();
    await flush();
    useAuth.getState().logout();
    useAuth.getState().setSession(session(userB, "devB"));
    release();
    await p;
    await flush();
    expect(useNodes.getState().sessions["far.test"]).toBeUndefined();
  });

  it("a forced sign-out forgets the account's conversation index in memory (it decides which nodes need no confirmation)", () => {
    seed();
    useConversationIndex.setState({
      state: {
        version: 1,
        items: [
          {
            node: "far.test",
            kind: "room",
            room_id: "R",
            conversation_id: null,
            joined_at: "",
          },
        ],
      } as never,
    });
    useAuth.getState().logout();
    expect(useConversationIndex.getState().state ?? null).toBeNull();
  });
});
