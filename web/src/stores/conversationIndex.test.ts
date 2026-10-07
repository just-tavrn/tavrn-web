// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApiError, type ConversationIndexState, type UserPrivate } from "@tavrn/sdk";
import { useAuth } from "./auth";
import { useReach } from "./reach";
import { nodeDeps, resetNodeCaches, useNodes } from "./nodes";
import { applyOps, conversationEntry, entryKey, findDm, foreignNodes, roomEntry, syncIndex, useConversationIndex, writeIndex, type IndexItem } from "./conversationIndex";

const R1 = "01J0000000000000000000000A";
const R2 = "01J0000000000000000000000B";
const C1 = "01J0000000000000000000000C";

function user(domain: string): UserPrivate {
  return { id: "ID", username: "alice", domain, address: `alice@${domain}`, display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } as UserPrivate;
}

describe("index operations", () => {
  it("adds once, removes, and keeps unknown fields", () => {
    const old: IndexItem = { ...roomEntry("a.test", R1, "2026-01-01T00:00:00Z"), muted: true };
    let items = applyOps([old], [{ type: "add", entry: roomEntry("a.test", R1) }]);
    expect(items).toEqual([old]);
    items = applyOps(items, [{ type: "add", entry: roomEntry("b.test", R1) }]);
    expect(items.map(entryKey)).toEqual([`a.test|room|${R1}`, `b.test|room|${R1}`]);
    items = applyOps(items, [{ type: "remove", key: `a.test|room|${R1}` }]);
    expect(items.map(entryKey)).toEqual([`b.test|room|${R1}`]);
  });

  it("replaces the entries of one node and kind", () => {
    const keepMe: IndexItem = { ...roomEntry("a.test", R1, "2026-01-01T00:00:00Z"), muted: true };
    const items = [keepMe, roomEntry("a.test", R2), conversationEntry("a.test", "dm", C1, "bob@b.test"), roomEntry("b.test", R2)];
    const next = applyOps(items, [{ type: "replace", node: "a.test", kinds: ["room"], entries: [roomEntry("a.test", R1), roomEntry("a.test", C1)] }]);
    expect(next.map(entryKey)).toEqual([`a.test|room|${R1}`, `a.test|dm|${C1}`, `b.test|room|${R2}`, `a.test|room|${C1}`]);
    expect(next[0]).toEqual(keepMe);
    expect(conversationEntry("a.test", "dm", C1, "bob@b.test").peer).toBe("bob@b.test");
    expect(conversationEntry("a.test", "group", C1, "bob@b.test")).not.toHaveProperty("peer");
  });
});

describe("DM uniqueness across nodes (FEDERATION.md §6.1)", () => {
  it("finds an existing DM with the peer on any node, the newest when a race made two", () => {
    const C2 = "01J0000000000000000000000D";
    const state: ConversationIndexState = {
      version: 3,
      items: [roomEntry("b.test", R1), conversationEntry("b.test", "dm", C1, "bob@b.test"), conversationEntry("a.test", "group", R2, null), conversationEntry("a.test", "dm", C2, "bob@b.test"), conversationEntry("a.test", "dm", R2, "carol@c.test")],
    };
    expect(findDm("bob@b.test", state)).toMatchObject({ node: "a.test", conversation_id: C2 });
    expect(findDm("carol@c.test", state)).toMatchObject({ node: "a.test", conversation_id: R2 });
    expect(findDm("dave@d.test", state)).toBeUndefined();
    expect(findDm("bob@b.test", null)).toBeUndefined();
  });
});

describe("writing with If-Match", () => {
  function client(server: { version: number; items: IndexItem[] }, conflicts = 0) {
    let left = conflicts;
    const puts: Array<{ version: number | null; items: IndexItem[] }> = [];
    return {
      puts,
      conversationIndex: {
        get: vi.fn(async (): Promise<ConversationIndexState> => ({ version: server.version, items: [...server.items] })),
        put: vi.fn(async (items: IndexItem[], version: number | null): Promise<ConversationIndexState> => {
          puts.push({ version, items });
          if (left > 0 || version !== server.version) {
            left--;
            // Another device wrote in between.
            server.version++;
            server.items = [...server.items, roomEntry("c.test", R2)];
            throw new TavrnApiError({ type: "x", title: "", status: 412, detail: "", code: "index.version_conflict", meta: { version: server.version } });
          }
          server.version++;
          server.items = items;
          return { version: server.version, items };
        }),
      },
    };
  }

  it("merges own changes into the fresh list after a conflict", async () => {
    const server = { version: 4, items: [roomEntry("a.test", R1)] };
    const c = client(server, 1);
    const result = await writeIndex(c as never, [{ type: "add", entry: roomEntry("b.test", R2) }], { version: 4, items: [roomEntry("a.test", R1)] });
    expect(c.puts.map((p) => p.version)).toEqual([4, 5]);
    expect(result.version).toBe(6);
    expect(result.items.map(entryKey)).toEqual([`a.test|room|${R1}`, `c.test|room|${R2}`, `b.test|room|${R2}`]);
  });

  it("does not write an unchanged list and gives up after repeated conflicts", async () => {
    const server = { version: 1, items: [roomEntry("a.test", R1)] };
    const c = client(server);
    await writeIndex(c as never, [{ type: "add", entry: roomEntry("a.test", R1) }], null);
    expect(c.puts).toHaveLength(0);
    const busy = client({ version: 1, items: [] }, 99);
    await expect(writeIndex(busy as never, [{ type: "add", entry: roomEntry("a.test", R2) }], null)).rejects.toMatchObject({ code: "index.version_conflict" });
    expect(busy.puts).toHaveLength(4);
  });
});

describe("reconciliation and new devices", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let index: { version: number; items: IndexItem[] };
  let down: Set<string>;

  beforeEach(() => {
    localStorage.clear();
    resetNodeCaches();
    useNodes.setState({ sessions: {} });
    useReach.setState({ nodes: {} });
    useConversationIndex.setState({ state: null });
    useAuth.setState({ token: "home", refresh: "r", user: user("a.test"), deviceId: "D", home: { domain: "a.test", base: "https://a.test", ws: "wss://a.test/api/v1/ws" } });
    nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/ws`, web: `https://${domain}` });
    index = { version: 2, items: [roomEntry("a.test", R2), roomEntry("b.test", R1), roomEntry("c.test", R1)] };
    down = new Set(["c.test"]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (down.has(url.hostname)) throw new TypeError("Failed to fetch");
      const path = url.pathname.replace("/api/v1", "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/users/me/conversations-index" && init?.method === "PUT") {
        index = { version: index.version + 1, items: body.items };
        return json(200, index);
      }
      if (path === "/users/me/conversations-index") return json(200, index);
      if (path === "/federation/token") return json(200, { token: "fed", target: body.target, expires_in: 600 });
      if (path === "/auth/federated") return json(200, { status: "ok", user: user("a.test"), access_token: "t", refresh_token: "r", expires_in: 3600, device_id: "D", recovery_code_used: false, session_expires_at: "2099-01-01T00:00:00Z" });
      if (path === "/rooms" && url.hostname === "a.test") return json(200, [{ id: R1, name: "Local" }]);
      if (path === "/rooms" && url.hostname === "b.test") return json(200, [{ id: R1, name: "Remote" }, { id: R2, name: "Joined elsewhere" }]);
      if (path === "/conversations" && url.hostname === "a.test") return json(200, [{ id: C1, kind: "dm", members: [user("a.test"), { ...user("b.test"), username: "bob", address: "bob@b.test" }] }]);
      if (path === "/conversations") return json(200, []);
      return json(404, { type: "x", title: "", status: 404, detail: path, code: "route.not_found" });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("re-establishes sessions for the nodes of the index and reconciles every reachable node", async () => {
    await syncIndex();
    expect(Object.keys(useNodes.getState().sessions).sort()).toEqual(["b.test"]);
    expect(useReach.getState().nodes["c.test"]).toBe("unreachable");
    const keys = index.items.map(entryKey).sort();
    expect(keys).toEqual([`a.test|dm|${C1}`, `a.test|room|${R1}`, `b.test|room|${R1}`, `b.test|room|${R2}`, `c.test|room|${R1}`].sort());
    expect(index.items.find((e) => e.kind === "dm")?.peer).toBe("bob@b.test");
    expect(foreignNodes(useConversationIndex.getState().state)).toEqual(["b.test", "c.test"]);
  });
});
