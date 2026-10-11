// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useConversationIndex } from "../stores/conversationIndex";
import { confirmNode, nodeDeps, resetNodeCaches, useNodes } from "../stores/nodes";
import { useReach } from "../stores/reach";
import { renderWithProviders } from "../test/render";
import { NodeScope, NodeSessionBanner, conversationPath, roomPath, useNode } from "./NodeScope";

const me = { id: "A-ID", username: "alice", domain: "a.test", address: "alice@a.test", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

function Probe() {
  const node = useNode();
  return <p data-testid="probe">{`${node.domain}|${node.home}|${node.me?.id}|${node.roomPath("R1", "C1")}`}</p>;
}

const originalDeps = { ...nodeDeps };

beforeEach(() => {
  Object.assign(nodeDeps, originalDeps);
  resetNodeCaches();
  useNodes.getState().clear();
  useReach.setState({ nodes: {} });
  useAuth.setState({ token: "t", refresh: "r", user: me, deviceId: "D", home: null });
  useConversationIndex.setState({ state: { version: 1, items: [] } as never });
});

describe("node routes and scopes", () => {
  it("keeps the home node's routes and prefixes other nodes", () => {
    expect(roomPath(null, "R1")).toBe("/rooms/R1");
    expect(roomPath("a.test", "R1", "C1")).toBe("/rooms/R1/channels/C1");
    expect(roomPath("b.test", "R1", "C1")).toBe("/n/b.test/rooms/R1/channels/C1");
    expect(roomPath("b.test", "R1", undefined, "settings/roles")).toBe("/n/b.test/rooms/R1/settings/roles");
  });

  it("without a scope views talk to the home node", () => {
    renderWithProviders(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("a.test|true|A-ID|/rooms/R1/channels/C1");
  });

  it("inside a scope views get the node, its client and the node-local user", () => {
    useNodes.getState().put({ domain: "b.test", base: "https://b.test", ws: "wss://b.test/ws", web: "https://b.test", token: "bt", refresh: "br", deviceId: "D", user: { ...me, id: "B-ID" } as never, expiresAt: Date.now() + 7 * 86_400_000 });
    renderWithProviders(
      <NodeScope domain="b.test">
        <Probe />
      </NodeScope>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("b.test|false|B-ID|/n/b.test/rooms/R1/channels/C1");
  });

  it("routes DMs of other nodes under their domain", () => {
    expect(conversationPath(null, "C1")).toBe("/conversations/C1");
    expect(conversationPath("a.test", "C1")).toBe("/conversations/C1");
    expect(conversationPath("b.test", "C1")).toBe("/n/b.test/conversations/C1");
  });

  it("asks to sign in again on a node that refused the session; a new session clears it", async () => {
    const session = { domain: "b.test", base: "https://b.test", ws: "wss://b.test/ws", web: "https://b.test", token: "bt", refresh: "br", deviceId: "D", user: { ...me, id: "B-ID" } as never, expiresAt: Date.now() + 7 * 86_400_000 };
    let logins = 0;
    nodeDeps.home = () => ({ federation: { token: async () => ({ token: "fed", target: "b.test", expires_in: 600 }) } }) as never;
    nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/ws`, web: `https://${domain}` });
    globalThis.fetch = (async () => {
      logins++;
      return new Response(JSON.stringify({ status: "ok", user: session.user, access_token: "new", refresh_token: "r", expires_in: 3600, device_id: "D", session_expires_at: "2099-01-01T00:00:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    useNodes.getState().put(session);
    useNodes.getState().fail("b.test", "federation.user_banned");
    renderWithProviders(<NodeSessionBanner domain="b.test" code="federation.user_banned" />);
    const banner = screen.getByTestId("node-session-banner");
    expect(banner).toHaveTextContent("Deine Sitzung auf b.test ist beendet");
    await userEvent.setup().click(screen.getByRole("button", { name: "Erneut anmelden" }));
    await vi.waitFor(() => expect(useNodes.getState().failed).toEqual({}));
    expect(logins).toBe(1);
    expect(useNodes.getState().sessions["b.test"]!.token).toBe("new");
  });

  it("shows only the banner of a node that cannot be reached; quiet scopes show nothing", async () => {
    confirmNode("c.test");
    nodeDeps.discover = async () => {
      useReach.getState().set("c.test", "unreachable");
      throw new TypeError("Failed to fetch");
    };
    renderWithProviders(
      <>
        <NodeScope domain="c.test">
          <Probe />
        </NodeScope>
        <NodeScope domain="c.test" quiet>
          <Probe />
        </NodeScope>
      </>,
    );
    const banner = await screen.findByTestId("node-unreachable-banner");
    expect(banner).toHaveAttribute("data-node", "c.test");
    expect(banner).toHaveTextContent("c.test ist gerade nicht erreichbar");
    expect(screen.getAllByTestId("node-unreachable-banner")).toHaveLength(1);
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("shows the block warning when the home node does not federate with the node (FEDERATION.md §9.4)", async () => {
    confirmNode("c.test");
    nodeDeps.discover = async () => {
      throw new TavrnApiError({ type: "x", title: "", status: 403, detail: "", code: "federation.peer_blocked" });
    };
    renderWithProviders(
      <NodeScope domain="c.test">
        <Probe />
      </NodeScope>,
    );
    expect(await screen.findByTestId("peer-blocked")).toHaveTextContent("föderiert nicht mit c.test");
    expect(screen.queryByTestId("node-unreachable-banner")).toBeNull();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  it("asks before the first sign-in on a node the account has nothing on, and stores nothing before", async () => {
    const session = { domain: "evil.test", base: "https://evil.test", ws: "wss://evil.test/ws", web: "https://evil.test" };
    const contacted: string[] = [];
    nodeDeps.home = () => ({ federation: { token: async (d: string) => (contacted.push(`token:${d}`), { token: "fed", target: d, expires_in: 600 }) } }) as never;
    nodeDeps.discover = async (domain) => (contacted.push(`discover:${domain}`), { ...session, domain });
    globalThis.fetch = (async (url: string) => {
      contacted.push(String(url));
      return new Response(JSON.stringify({ status: "ok", user: { ...me, id: "E-ID" }, access_token: "x", refresh_token: "r", expires_in: 3600, device_id: "D", session_expires_at: "2099-01-01T00:00:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    renderWithProviders(
      <>
        <NodeScope domain="evil.test">
          <Probe />
        </NodeScope>
        <NodeScope domain="evil.test" quiet>
          <Probe />
        </NodeScope>
      </>,
    );
    const ask = await screen.findByTestId("node-connect-confirm");
    expect(ask).toHaveTextContent("Mit evil.test als alice@a.test verbinden?");
    expect(contacted.filter((c) => c.includes("evil.test"))).toEqual([]);
    expect(useNodes.getState().sessions).toEqual({});
    await userEvent.setup().click(screen.getByRole("button", { name: "Verbinden" }));
    await vi.waitFor(() => expect(useNodes.getState().sessions["evil.test"]?.token).toBe("x"));
    expect(contacted).toContain("token:evil.test");
    expect(await screen.findAllByTestId("probe")).toHaveLength(2);
  });

  it("signs in without asking on a node the conversation index names", async () => {
    useConversationIndex.setState({ state: { version: 1, items: [{ node: "b.test", kind: "room", room_id: "R1", conversation_id: null, joined_at: "" }] } as never });
    nodeDeps.home = () => ({ federation: { token: async (d: string) => ({ token: "fed", target: d, expires_in: 600 }) } }) as never;
    nodeDeps.discover = async (domain) => ({ domain, base: `https://${domain}`, ws: `wss://${domain}/ws`, web: `https://${domain}` });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "ok", user: { ...me, id: "B-ID" }, access_token: "bt", refresh_token: "r", expires_in: 3600, device_id: "D", session_expires_at: "2099-01-01T00:00:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    renderWithProviders(
      <NodeScope domain="b.test">
        <Probe />
      </NodeScope>,
    );
    expect(await screen.findByTestId("probe")).toHaveTextContent("b.test|false|B-ID");
    expect(screen.queryByTestId("node-connect-confirm")).toBeNull();
  });
});
