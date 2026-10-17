// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInvite, UserPrivate } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useReach } from "../stores/reach";
import { nodeDeps, resetNodeCaches, useNodes } from "../stores/nodes";
import { entryKey, useConversationIndex, type IndexItem } from "../stores/conversationIndex";
import { acceptFriendInvites, acceptInvite, autoAccepts, invitePreview } from "./invites";

const ROOM = "01J0000000000000000000000A";
const CONV = "01J0000000000000000000000C";

function user(domain: string, username = "alice"): UserPrivate {
  return { id: `${username}-${domain}`, username, domain, address: `${username}@${domain}`, display_name: username, kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } as UserPrivate;
}

function invite(patch: Partial<PendingInvite>): PendingInvite {
  return { id: "I1", kind: "conversation", node: "b.test", inviter: "bob@b.test", received_at: "", conversation: { id: CONV, kind: "dm", members: ["bob@b.test", "alice@a.test"] }, ...patch };
}

describe("which invitations are accepted without asking", () => {
  it("only DMs and group DMs started by a friend", () => {
    expect(autoAccepts(invite({}), ["bob@b.test"])).toBe(true);
    expect(autoAccepts(invite({}), ["carol@c.test"])).toBe(false);
    expect(autoAccepts(invite({ kind: "room", conversation: null, room: { id: ROOM, name: "x" }, invite_code: "code" }), ["bob@b.test"])).toBe(false);
    expect(autoAccepts(invite({ conversation: null }), ["bob@b.test"])).toBe(false);
    // A node naming a friend of another domain as the inviter is not trusted with an automatic join.
    expect(autoAccepts(invite({ node: "evil.test" }), ["bob@b.test"])).toBe(false);
  });
});

describe("accepting an invitation of another node", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let index: { version: number; items: IndexItem[] };
  let calls: Array<{ method: string; url: string; auth?: string }>;
  let bodies: Record<string, unknown>;
  let pending: PendingInvite[];

  beforeEach(() => {
    localStorage.clear();
    resetNodeCaches();
    useNodes.setState({ sessions: {}, failed: {} });
    useReach.setState({ nodes: {} });
    useConversationIndex.setState({ state: null });
    useAuth.setState({ token: "home", refresh: "r", user: user("a.test"), deviceId: "D", home: { domain: "a.test", base: "https://a.test", ws: "wss://a.test/api/v1/ws" } });
    nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/ws`, web: `https://${domain}` });
    index = { version: 1, items: [] };
    calls = [];
    bodies = {};
    pending = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ method, url: url.href, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      const path = url.pathname.replace("/api/v1", "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      bodies[`${method} ${url.href}`] = body;
      const host = url.hostname;
      if (host === "a.test" && path === "/users/me/conversations-index" && method === "PUT") {
        index = { version: index.version + 1, items: body.items };
        return json(200, index);
      }
      if (host === "a.test" && path === "/users/me/conversations-index") return json(200, index);
      if (host === "a.test" && path === "/federation/token") return json(200, { token: "fed", target: body.target, expires_in: 600 });
      if (host === "a.test" && path === "/users/me/invites") return json(200, { items: pending });
      if (host === "a.test" && path === "/users/me/friends") return json(200, { friends: [{ user: user("b.test", "bob"), since: "" }], incoming: [], outgoing: [], blocked: [] });
      if (host === "a.test" && path.startsWith("/users/me/invites/") && method === "DELETE") return new Response(null, { status: 204 });
      if (host === "b.test" && path === "/auth/federated") return json(200, { status: "ok", user: user("a.test"), access_token: "b-token", refresh_token: "r", expires_in: 3600, device_id: "D", recovery_code_used: false, session_expires_at: "2099-01-01T00:00:00Z" });
      if (host === "b.test" && path === "/invites/CODE/join") return json(200, { id: ROOM, name: "Lounge", channels: [] });
      if (host === "b.test" && path === `/rooms/${ROOM}/join`) return json(200, { id: ROOM, name: "Lounge", channels: [] });
      if (host === "b.test" && path === "/invites/CODE") return json(200, { code: "CODE", room: { id: ROOM, name: "Lounge" }, rules: "Be kind.", privacy_notice: "", legal_notice: "" });
      if (host === "b.test" && path === `/rooms/${ROOM}/preview`) return json(200, { room: { id: ROOM, name: "Lounge" }, rules: "", privacy_notice: "Privacy", legal_notice: "" });
      if (host === "b.test" && path === `/conversations/${CONV}`) return json(200, { id: CONV, kind: "dm", encrypted: true, created_at: "", members: [user("b.test", "bob"), user("a.test")] });
      return json(404, { type: "x", title: "", status: 404, detail: path, code: "route.not_found" });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("room: federated session on the room's node, join with the bound invite, index entry, dismissed", async () => {
    const path = await acceptInvite(invite({ kind: "room", conversation: null, room: { id: ROOM, name: "Lounge" }, invite_code: "CODE", inviter: "carol@b.test" }));
    expect(path).toBe(`/n/b.test/rooms/${ROOM}`);
    expect(calls).toContainEqual({ method: "POST", url: "https://b.test/api/v1/invites/CODE/join", auth: "Bearer b-token" });
    expect(index.items.map(entryKey)).toEqual([`b.test|room|${ROOM}`]);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://a.test/api/v1/users/me/invites/I1" });
  });

  it("room: the rules answer is the user's (false unless the join dialog's checkbox was ticked), never assumed", async () => {
    const room = invite({ kind: "room", conversation: null, room: { id: ROOM, name: "Lounge" }, invite_code: "CODE", inviter: "carol@b.test" });
    await acceptInvite(room);
    expect(bodies["POST https://b.test/api/v1/invites/CODE/join"]).toEqual({ accept_rules: false });
    await acceptInvite(room, true);
    expect(bodies["POST https://b.test/api/v1/invites/CODE/join"]).toEqual({ accept_rules: true });
    // Without a code (a public room): the room's own join route.
    await acceptInvite(invite({ kind: "room", conversation: null, room: { id: ROOM, name: "Lounge" }, inviter: "carol@b.test" }), true);
    expect(bodies[`POST https://b.test/api/v1/rooms/${ROOM}/join`]).toEqual({ accept_rules: true });
  });

  it("room preview before the join: the invite preview of the code on the hosting node, the room preview without one", async () => {
    const withCode = await invitePreview(invite({ kind: "room", conversation: null, room: { id: ROOM, name: "Lounge" }, invite_code: "CODE" }));
    expect(withCode.rules).toBe("Be kind.");
    expect(calls).toContainEqual({ method: "GET", url: "https://b.test/api/v1/invites/CODE", auth: "Bearer b-token" });
    const withoutCode = await invitePreview(invite({ kind: "room", conversation: null, room: { id: ROOM, name: "Lounge" } }));
    expect(withoutCode.privacy_notice).toBe("Privacy");
    expect(calls).toContainEqual({ method: "GET", url: `https://b.test/api/v1/rooms/${ROOM}/preview`, auth: "Bearer b-token" });
  });

  it("conversation: checked on the hosting node, indexed with the peer from the node's member list", async () => {
    // The invitation names someone else as members; the hosting node's answer decides.
    const path = await acceptInvite(invite({ conversation: { id: CONV, kind: "dm", members: ["mallory@m.test"] } }));
    expect(path).toBe(`/n/b.test/conversations/${CONV}`);
    expect(calls).toContainEqual({ method: "GET", url: `https://b.test/api/v1/conversations/${CONV}`, auth: "Bearer b-token" });
    expect(index.items).toEqual([expect.objectContaining({ node: "b.test", kind: "dm", conversation_id: CONV, peer: "bob@b.test" })]);
  });

  it("at start, accepts the pending conversation invitations of friends only", async () => {
    pending = [invite({ id: "I1" }), invite({ id: "I2", inviter: "eve@e.test", conversation: { id: "01J0000000000000000000000E", kind: "dm" } }), invite({ id: "I3", kind: "room", conversation: null, room: { id: ROOM }, invite_code: "CODE" })];
    expect(await acceptFriendInvites()).toEqual(["b.test"]);
    expect(index.items.map(entryKey)).toEqual([`b.test|dm|${CONV}`]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://a.test/api/v1/users/me/invites/I1"]);
    expect(calls.some((c) => c.url.includes("/invites/CODE/join"))).toBe(false);
  });
});
