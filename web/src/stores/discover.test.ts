// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApi, b64urlEncode, type DirectoryRoom, type PublicKeyInfo, type UserPrivate, type WellKnown } from "@tavrn/sdk";

vi.mock("./conversationIndex", () => ({ indexJoinedRoom: vi.fn(async () => undefined) }));

import { indexJoinedRoom } from "./conversationIndex";
import { useAuth } from "./auth";
import { nodeDeps, resetNodeCaches, useNodes } from "./nodes";
import { discoverDeps, iconClient, joinRoom, keysOf, loadNodes, loadRoomIcons, loadRooms, resetDiscoverCaches } from "./discover";

const subtle = globalThis.crypto.subtle;
const enc = (v: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
const ROOM_A = "01J0000000000000000000000A";
const ROOM_B = "01J0000000000000000000000B";
const NOW = Date.parse("2026-10-05T12:00:00Z");

async function nodeKey(domain: string) {
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const x = b64urlEncode(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const info: PublicKeyInfo = { kid: `${domain}-1`, alg: "EdDSA", crv: "Ed25519", x };
  const listing = async (roomId: string, over: Record<string, unknown> = {}) => {
    const iat = Math.floor(Date.now() / 1000) - 10;
    const claims = { iss: domain, sub: roomId, aud: "tavrn-directory", typ: "listing", iat, exp: iat + 48 * 3600, name: `Signed ${roomId.slice(-1)}`, description: "", member_count: 3, ...over };
    const input = `${enc({ alg: "EdDSA", typ: "JWT", kid: info.kid })}.${enc(claims)}`;
    const sig = await subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
  };
  return { info, listing };
}

function doc(domain: string, keys: PublicKeyInfo[]): WellKnown {
  return { tavrn: 1, domain, keys } as unknown as WellKnown;
}

function user(domain: string): UserPrivate {
  return { id: "ID", username: "alice", domain, address: `alice@${domain}`, display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } as UserPrivate;
}

function room(node: string, roomId: string, listing: string): DirectoryRoom {
  return { node, room_id: roomId, name: "Relayed name", description: "relayed", icon_url: null, member_count: 999, listing };
}

const realDirectory = discoverDeps.directory;
const realDocument = discoverDeps.document;
const realNow = discoverDeps.now;

beforeEach(() => {
  resetDiscoverCaches();
  resetNodeCaches();
  localStorage.clear();
  useNodes.setState({ sessions: {} });
  useAuth.setState({ token: "home-token", refresh: "home-refresh", user: user("a.test"), deviceId: "DEV", home: { domain: "a.test", base: "https://a.test", ws: "wss://a.test/api/v1/ws" } });
  vi.mocked(indexJoinedRoom).mockClear();
});

afterEach(() => {
  discoverDeps.directory = realDirectory;
  discoverDeps.document = realDocument;
  discoverDeps.now = realNow;
  vi.unstubAllGlobals();
});

describe("loading the directory", () => {
  it("keeps only rooms whose hosting node signed them and shows the signed values", async () => {
    const a = await nodeKey("a.test");
    const b = await nodeKey("b.test");
    const items = [
      room("a.test", ROOM_A, await a.listing(ROOM_A)),
      room("b.test", ROOM_B, await b.listing(ROOM_B)),
      // A listing a.test signed, relayed as if it came from b.test.
      room("b.test", ROOM_A, await a.listing(ROOM_A, { iss: "b.test" })),
      // Expired.
      room("b.test", "01J0000000000000000000000C", await b.listing("01J0000000000000000000000C", { iat: 1, exp: 2 })),
    ];
    const rooms = vi.fn(async () => ({ items, next: "cursor-2" }));
    discoverDeps.directory = () => ({ rooms, nodes: vi.fn(), node: vi.fn() }) as unknown as TavrnApi["directory"];
    const document = vi.fn(async (domain: string) => doc(domain, domain === "a.test" ? [a.info] : [b.info]));
    discoverDeps.document = document;

    const page = await loadRooms({ q: "  brett ", minMembers: 5, node: "b.test", cursor: "c1" });
    expect(rooms).toHaveBeenCalledWith({ q: "brett", node: "b.test", min_members: 5, cursor: "c1", limit: 50 });
    expect(page.rooms.map((r) => `${r.node}/${r.room_id}`)).toEqual([`a.test/${ROOM_A}`, `b.test/${ROOM_B}`]);
    expect(page.rooms[1]).toMatchObject({ name: "Signed B", member_count: 3, verification: "valid" });
    expect(page).toMatchObject({ next: "cursor-2", hidden: 2 });
    expect(document).toHaveBeenCalledTimes(2);

    // Keys are cached per node for an hour.
    await loadRooms();
    expect(document).toHaveBeenCalledTimes(2);
  });

  it("refuses a discovery document of another domain", async () => {
    const b = await nodeKey("b.test");
    discoverDeps.document = async () => doc("evil.test", [b.info]);
    await expect(keysOf("b.test")).rejects.toThrow();
  });

  it("drops the rooms of a node whose keys cannot be loaded", async () => {
    const b = await nodeKey("b.test");
    discoverDeps.directory = () => ({ rooms: async () => ({ items: [room("b.test", ROOM_B, await b.listing(ROOM_B))], next: null }) }) as unknown as TavrnApi["directory"];
    discoverDeps.document = async () => {
      throw new Error("unreachable");
    };
    expect(await loadRooms()).toMatchObject({ rooms: [], hidden: 1, next: null });
  });

  it("loads nodes with a trimmed search", async () => {
    const nodes = vi.fn(async () => ({ items: [], next: null }));
    discoverDeps.directory = () => ({ nodes }) as unknown as TavrnApi["directory"];
    await loadNodes({ q: " x ", cursor: "b.test" });
    expect(nodes).toHaveBeenCalledWith({ q: "x", cursor: "b.test" });
  });
});

describe("joining from Discover", () => {
  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("joins a room of the home node directly", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json(200, { id: ROOM_A, name: "A" });
      }),
    );
    expect(await joinRoom({ node: "a.test", room_id: ROOM_A })).toBe(`/rooms/${ROOM_A}`);
    expect(calls).toEqual([`https://a.test/api/v1/rooms/${ROOM_A}/join`]);
    expect(indexJoinedRoom).toHaveBeenCalledWith(null, ROOM_A);
  });

  it("opens a federated session on another node, joins there and routes under its domain", async () => {
    nodeDeps.now = () => NOW;
    nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/api/v1/ws`, web: `https://${domain}` });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "https://a.test/api/v1/federation/token") return json(200, { token: "fed", target: "b.test", expires_in: 600 });
        if (url === "https://b.test/api/v1/auth/federated")
          return json(200, { status: "ok", user: user("a.test"), access_token: "b-token", refresh_token: "b-refresh", expires_in: 3600, device_id: "DEV", recovery_code_used: false, session_expires_at: new Date(NOW + 7 * 24 * 3600 * 1000).toISOString() });
        if (url === `https://b.test/api/v1/rooms/${ROOM_B}/join`) return json(200, { id: ROOM_B, name: "B" });
        return json(404, { code: "route.not_found" });
      }),
    );
    expect(await joinRoom({ node: "b.test", room_id: ROOM_B })).toBe(`/n/b.test/rooms/${ROOM_B}`);
    expect(calls).toEqual(["POST https://a.test/api/v1/federation/token", "POST https://b.test/api/v1/auth/federated", `POST https://b.test/api/v1/rooms/${ROOM_B}/join`]);
    expect(useNodes.getState().sessions["b.test"]?.token).toBe("b-token");
    expect(indexJoinedRoom).toHaveBeenCalledWith("b.test", ROOM_B);
  });
});

describe("room icons on Discover (design note 4.9)", () => {
  it("loads icons only from nodes this client already talks to (FEDERATION.md §7.4)", () => {
    // Home node a.test, web client loaded from o.test, a session on b.test, nothing with c.test.
    useNodes.setState({ sessions: { "b.test": { domain: "b.test", base: "https://b.test", ws: "wss://b.test/api/v1/ws", web: "https://b.test", token: "t", refresh: "r", deviceId: "DEV", user: user("a.test"), expiresAt: NOW } } });
    expect(iconClient("a.test", "o.test")?.mediaUrl("/api/v1/media/X")).toBe("https://a.test/api/v1/media/X");
    expect(iconClient("b.test", "o.test")?.mediaUrl("/api/v1/media/X")).toBe("https://b.test/api/v1/media/X");
    expect(iconClient("o.test", "o.test")?.mediaUrl("/api/v1/media/X")).toBe("/api/v1/media/X");
    expect(iconClient("c.test", "o.test")).toBeNull();
    expect(iconClient("c.test", null)).toBeNull();
  });

  it("maps the public rooms of a node to absolute still and animated URLs, skipping rooms without an icon", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        const rooms = [
          { id: ROOM_A, name: "A", description: "", icon_blob_id: null, icon: "/api/v1/media/I/animated", icon_still: "/api/v1/media/I", icon_animated: true, member_count: 2 },
          { id: ROOM_B, name: "B", description: "", icon_blob_id: null, icon: "/api/v1/media/S", icon_still: "/api/v1/media/S", icon_animated: false, member_count: 1 },
          { id: "01J0000000000000000000000C", name: "C", description: "", icon_blob_id: null, icon: null, icon_still: null, icon_animated: false, member_count: 1 },
          // Only paths of the node itself become URLs.
          { id: "01J0000000000000000000000D", name: "D", description: "", icon_blob_id: null, icon: "https://evil.test/x.webp", icon_still: "https://evil.test/x.webp", icon_animated: false, member_count: 1 },
        ];
        return new Response(JSON.stringify(rooms), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    expect(await loadRoomIcons(iconClient("a.test", null)!)).toEqual({
      [ROOM_A]: { still: "https://a.test/api/v1/media/I", animated: "https://a.test/api/v1/media/I/animated" },
      [ROOM_B]: { still: "https://a.test/api/v1/media/S", animated: null },
    });
    expect(calls).toEqual(["https://a.test/api/v1/rooms/discover"]);
  });
});
