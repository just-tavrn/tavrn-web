// SPDX-License-Identifier: Apache-2.0
// The composer inside a conversation: `@` suggests only who is in this channel or DM, a picked mention travels in the
// envelope's `mentions`, and the unsent text is kept per conversation while the app runs (docs/CLIENT.md).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Permission, type Member, type RoomDetail, type User } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { ConversationView } from "./ConversationView";
import { clearDrafts } from "../composer/drafts";

vi.mock("../hooks/useE2eeConversation", () => ({
  useE2eeConversation: () => ({ phase: "ready", mls: null, waiting: [], ghosts: [], error: null, rejoined: false, tick: 0 }),
  useDecrypted: () => ({}),
  usePlainSignatures: () => ({}),
}));

const me = { id: "bob", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();
const user = (address: string, extra: Partial<User> = {}): User => {
  const [username, domain] = address.split("@") as [string, string];
  return { id: username, address, username, domain, display_name: username[0]!.toUpperCase() + username.slice(1), kind: "user", is_node_admin: false, created_at: "", ...extra };
};
const member = (address: string, roles: string[] = []): Member => ({ user: user(address), roles, joined_at: "", room_avatar_animated: false }) as Member;

const room = {
  id: "r1",
  owner_id: "bob",
  roles: [
    { id: "everyone", name: "@everyone", is_everyone: true, mentionable: false, permissions: bits(Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES), position: 0, hoist: false, room_id: "r1" },
    { id: "staff", name: "Staff", is_everyone: false, mentionable: true, permissions: "0", position: 1, hoist: false, room_id: "r1" },
  ],
  // "c1" is closed to everyone but the staff role.
  overrides: [
    { target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "everyone", allow: "0", deny: bits(Permission.VIEW_CHANNEL) },
    { target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "staff", allow: bits(Permission.VIEW_CHANNEL), deny: "0" },
  ],
  channels: [{ id: "c1", kind: "text", category_id: null, no_bots: false, no_bots_effective: false, encrypted: false }],
} as unknown as RoomDetail;
const members = [member("bob@t.local"), member("alice@t.local", ["staff"]), member("anna@t.local"), member("carl@far.example", ["staff"])];

function routes(posted: unknown[]) {
  return {
    "/conversations/c1/messages": (init: RequestInit) => {
      if (init.method !== "POST") return { body: [] };
      const body = JSON.parse(String(init.body));
      posted.push(body);
      return { body: { id: "01J00000000000000000000001", conversation_id: "c1", author: "bob@t.local", ...body, encrypted: false, created_at: "2026-10-05T00:00:00Z", reactions: [], attachments: [] } };
    },
    "/.well-known/tavrn": { body: { policies: { upload_max_bytes: 1000, uploads_enabled: true } } },
    "/node": { body: { gif_provider: null, dm_policy: "friends" } },
  };
}

function channel() {
  return (
    <ConversationView
      conversationId="c1"
      encrypted={false}
      header={<h1>x</h1>}
      placeholder="Nachricht"
      canSend
      canManage={false}
      canAttach={false}
      canReact
      canPin
      members={members.map((m) => m.user.address)}
      mayManage={false}
      domain="t.local"
      room={room}
      roomId="r1"
      roomMembers={members}
      permissions={Permission.SEND_MESSAGES}
      mentionContext={{ domain: "t.local", users: members.map((m) => ({ address: m.user.address })), roles: room.roles, memberRoles: Object.fromEntries(members.map((m) => [m.user.address, m.roles])), canMentionEveryone: false }}
    />
  );
}

afterEach(() => clearDrafts());

describe("ConversationView: the composer's mentions and drafts", () => {
  it("suggests the members who can view this channel and its roles, and the picked mention is sent in the envelope", async () => {
    useAuth.setState({ token: "t", user: me });
    const posted: unknown[] = [];
    mockFetch(routes(posted));
    renderWithProviders(channel());
    const box = screen.getByLabelText("Nachricht");
    await waitFor(() => expect(box).toBeEnabled());
    const u = userEvent.setup();
    await u.type(box, "@");
    const list = screen.getByRole("listbox", { name: "Personen und Rollen zum Erwähnen" });
    // anna cannot view the channel: never offered. The own user comes last.
    expect(within(list).getAllByRole("option").map((o) => o.getAttribute("data-key"))).toEqual(["alice@t.local", "carl@far.example", "role:staff", "bob@t.local"]);
    await u.type(box, "car{Enter}hallo{Enter}");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ content: { type: "text", body: "@carl@far.example hallo" }, mentions: ["carl@far.example"] });
  });

  it("keeps the unsent text per conversation: leaving and opening the channel again restores it", async () => {
    useAuth.setState({ token: "t", user: me });
    mockFetch(routes([]));
    const first = renderWithProviders(channel());
    const u = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText("Nachricht")).toBeEnabled());
    await u.type(screen.getByLabelText("Nachricht"), "noch nicht fertig");
    first.unmount();
    renderWithProviders(channel());
    expect(screen.getByLabelText("Nachricht")).toHaveValue("noch nicht fertig");
  });

  it("DMs suggest the participants only", async () => {
    useAuth.setState({ token: "t", user: me });
    mockFetch({ ...routes([]), "/conversations/d1/messages": { body: [] } });
    const people = [user("bob@t.local"), user("dora@t.local"), user("eve@far.example")];
    renderWithProviders(
      <ConversationView
        conversationId="d1"
        encrypted
        header={<h1>x</h1>}
        placeholder="Nachricht"
        canSend
        canManage={false}
        canAttach={false}
        canReact
        canPin
        members={people.map((p) => p.address)}
        direct={people.map((p) => p.address)}
        mayManage
        people={people}
        domain="t.local"
        mentionContext={{ domain: "t.local", users: people.map((p) => ({ address: p.address })), canMentionEveryone: false }}
      />,
    );
    const u = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText("Nachricht")).toBeEnabled());
    await u.type(screen.getByLabelText("Nachricht"), "@");
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.getAttribute("data-key"))).toEqual(["dora@t.local", "eve@far.example", "bob@t.local"]);
  });
});

describe("ConversationView: #channel links", () => {
  it("offers the room's channels the user can view (never a hidden one), none in DMs", async () => {
    useAuth.setState({ token: "t", user: me });
    mockFetch(routes([]));
    const linkRoom = {
      ...room,
      is_owner: false,
      my_roles: [],
      categories: [],
      channels: [
        { id: "01J9ZK3G5M8Q2W4E6R8T0Y2CAA", name: "offen", kind: "text", category_id: null, position: 0, encrypted: false },
        { id: "01J9ZK3G5M8Q2W4E6R8T0Y2CBB", name: "ohne-zugang", kind: "text", category_id: null, position: 1, encrypted: false },
        { id: "c1", name: "hier", kind: "text", category_id: null, position: 2, encrypted: false },
      ],
      overrides: [{ target_type: "channel", target_id: "01J9ZK3G5M8Q2W4E6R8T0Y2CBB", subject_type: "role", subject_id: "everyone", allow: "0", deny: bits(Permission.VIEW_CHANNEL) }],
    } as unknown as RoomDetail;
    renderWithProviders(
      <ConversationView conversationId="c1" encrypted={false} header={<h1>x</h1>} placeholder="Nachricht" canSend canManage={false} canAttach={false} canReact canPin members={["bob@t.local"]} mayManage={false} domain="t.local" room={linkRoom} roomId="r1" roomMembers={members} permissions={Permission.SEND_MESSAGES} />,
    );
    const box = screen.getByLabelText("Nachricht");
    await waitFor(() => expect(box).toBeEnabled());
    const u = userEvent.setup();
    await u.type(box, "#o");
    expect(within(screen.getByRole("listbox", { name: "Kanäle zum Verlinken" })).getAllByRole("option").map((o) => o.getAttribute("data-key"))).toEqual(["01J9ZK3G5M8Q2W4E6R8T0Y2CAA"]);
    await u.keyboard("{Enter}");
    expect((box as HTMLTextAreaElement).value).toMatch(/\/rooms\/r1\/channels\/01J9ZK3G5M8Q2W4E6R8T0Y2CAA $/);
  });
});
