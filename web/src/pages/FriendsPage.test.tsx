// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Permission, type Presence, type VoiceParticipant } from "@tavrn/sdk";
import { useVoicePresence } from "../voice/presence";
import { useAuth } from "../stores/auth";
import { usePresence } from "../stores/presence";
import { useToasts } from "../stores/toasts";
import { mockFetch, renderWithProviders } from "../test/render";
import { FriendsPage } from "./FriendsPage";

const voice = vi.hoisted(() => ({ joinVoice: vi.fn(async () => true) }));
vi.mock("../voice", async (importOriginal) => ({ ...(await importOriginal<typeof import("../voice")>()), joinVoice: voice.joinVoice }));

const user = (id: string, username: string, kind = "user") => ({ id, username, domain: "t.local", address: `${username}@t.local`, display_name: username.toUpperCase(), kind, is_node_admin: false, avatar_blob_id: null, created_at: "" });

describe("FriendsPage", () => {
  it("lists friends, requests with their messages and blocks with notes, and calls the routes", async () => {
    useAuth.setState({ token: "t", user: { ...user("u0", "me"), email: null, email_verified: false, has_identity_key: true } });
    const calls = mockFetch({
      "/users/me/friends/requests/r1/accept": { body: { user: user("u1", "anna"), since: "" } },
      "/users/me/friends/requests": { status: 201, body: { status: "pending", user: user("u9", "zoe"), request_id: "r9" } },
      "/users/me/blocks": (init) => (init.method === "POST" ? { status: 204, body: null } : { body: [{ user: user("u4", "eve"), reason: "Spam", created_at: "2026-10-01T00:00:00Z" }] }),
      "/users/me/friends": {
        body: {
          friends: [{ user: user("u2", "botty", "bot"), since: "" }],
          incoming: [{ id: "r1", direction: "incoming", user: user("u1", "anna"), created_at: "", message: "Anna aus der Gilde" }],
          outgoing: [{ id: "r2", direction: "outgoing", user: user("u3", "ben"), created_at: "", message: null }],
          blocked: [user("u4", "eve")],
        },
      },
    });
    renderWithProviders(<FriendsPage />);
    const incoming = await screen.findByTestId("friends-incoming");
    expect(incoming).toHaveTextContent("anna@t.local");
    expect(within(incoming).getByTestId("friend-request-message")).toHaveTextContent("Anna aus der Gilde");
    expect(screen.getByTestId("friends-outgoing")).toHaveTextContent("ben@t.local");
    const blocked = screen.getByTestId("friends-blocked");
    await waitFor(() => expect(blocked).toHaveTextContent("eve@t.local"));
    expect(within(blocked).getByTestId("blocked-reason")).toHaveTextContent("Spam");
    expect(within(screen.getByTestId("friends-list")).getByTestId("bot-badge")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(within(incoming).getByRole("button", { name: "Annehmen" }));
    expect(calls.some((c) => c.url.endsWith("/users/me/friends/requests/r1/accept") && c.init.method === "POST")).toBe(true);

    // A request with a message.
    await u.type(screen.getByLabelText("Benutzername oder Adresse"), "zoe");
    await u.type(screen.getByLabelText("Nachricht (optional)"), "Hallo Zoe");
    await u.click(screen.getByRole("button", { name: "Anfrage senden" }));
    const sent = calls.find((c) => c.url.endsWith("/users/me/friends/requests") && c.init.method === "POST");
    expect(JSON.parse(String(sent!.init.body))).toEqual({ user: "zoe", message: "Hallo Zoe" });

    // Blocking asks for a private note.
    await u.click(within(screen.getByTestId("friends-list")).getByRole("button", { name: "Blockieren" }));
    await u.type(screen.getByLabelText("Private Notiz (optional)"), "nervt");
    await u.click(screen.getByTestId("block-confirm"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/users/me/blocks") && c.init.method === "POST")).toBe(true));
    const block = calls.find((c) => c.url.endsWith("/users/me/blocks") && c.init.method === "POST");
    expect(JSON.parse(String(block!.init.body))).toEqual({ user: "botty@t.local", reason: "nervt" });
  });

  it("sends one request on a double click and asks in the app before removing a friend", async () => {
    useAuth.setState({ token: "t", user: { ...user("u0", "me"), email: null, email_verified: false, has_identity_key: true } });
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (url.endsWith("/accept")) await slow;
      if (url.includes("/users/me/friends/") && init.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/accept")) return Response.json({ user: user("u1", "anna"), since: "" });
      if (url.endsWith("/users/me/friends")) return Response.json({ friends: [{ user: user("u2", "ben"), since: "" }], incoming: [{ id: "r1", direction: "incoming", user: user("u1", "anna"), created_at: "", message: null }], outgoing: [], blocked: [] });
      return Response.json([]);
    }) as typeof fetch;
    renderWithProviders(<FriendsPage />);
    const accept = within(await screen.findByTestId("friends-incoming")).getByRole("button", { name: "Annehmen" });
    fireEvent.click(accept);
    fireEvent.click(accept);
    await act(async () => release());
    expect(calls.filter((c) => c.endsWith("/accept"))).toHaveLength(1);

    const u = userEvent.setup();
    const removed = () => calls.filter((c) => c.startsWith("DELETE") && c.includes("/users/me/friends/ben"));
    await u.click(within(screen.getByTestId("friends-list")).getByRole("button", { name: "Entfernen" }));
    expect(screen.getByTestId("confirm-text")).toHaveTextContent("ben@t.local aus deinen Freunden entfernen?");
    await u.click(screen.getByTestId("confirm-cancel"));
    expect(removed()).toHaveLength(0);
    await u.click(within(screen.getByTestId("friends-list")).getByRole("button", { name: "Entfernen" }));
    await u.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(removed()).toHaveLength(1));
  });

  describe("friends in voice", () => {
    const vp = (username: string): VoiceParticipant => ({ user: `${username}@t.local`, user_id: `id-${username}`, device_id: "D", identity: `${username}@t.local/D`, muted: false, deafened: false, streaming: false, camera: false, server_muted: false, joined_at: "", connection: "connected" });
    const online = (username: string): Presence => ({ user: `${username}@t.local`, user_id: `id-${username}`, status: "online", custom_status: null, activity: null });
    beforeEach(() => {
      useVoicePresence.getState().reset();
      voice.joinVoice.mockClear();
      useAuth.setState({ token: "t", user: { ...user("u0", "me"), email: null, email_verified: false, has_identity_key: true } });
      // The friends' presences: anna is online; ben and carl have no entry (offline, or invisible: the node reports both as offline).
      usePresence.getState().clear();
      usePresence.getState().seed([online("anna")]);
      mockFetch({
        "/rooms/R1": { body: { id: "R1", name: "Gilde", description: "", channels: [{ id: "T1", kind: "text", name: "general" }, { id: "V1", kind: "voice", name: "Lounge" }], read_states: [], roles: [], overrides: [], my_permissions: "0", my_roles: [], is_owner: true, member_count: 3 } },
        "/rooms": { body: [{ id: "R1", name: "Gilde", description: "" }] },
        "/users/me/blocks": { body: [] },
        "/users/me/friends": {
          body: {
            friends: [
              { user: user("u1", "anna"), since: "" },
              { user: user("u2", "ben"), since: "" },
              { user: user("u3", "carl"), since: "" },
            ],
            incoming: [],
            outgoing: [],
            blocked: [],
          },
        },
      });
    });

    it("shows the room and channel of a friend in a viewable channel of a shared room, and nothing otherwise", async () => {
      act(() => {
        useVoicePresence.getState().apply("t.local", { room_id: "R1", channel_id: "V1", participants: [vp("anna")] });
        // A room the viewer is not a member of (a stale entry): nothing.
        useVoicePresence.getState().apply("t.local", { room_id: "R9", channel_id: "V9", participants: [vp("ben")] });
      });
      renderWithProviders(<FriendsPage />);
      const anna = await screen.findByText("anna@t.local");
      const item = anna.closest("li")!;
      await waitFor(() => expect(within(item).getByTestId("friend-voice")).toHaveTextContent("Im Sprachkanal: Gilde / Lounge"));
      const others = screen.getAllByTestId("friend-item").filter((li) => li !== item);
      expect(others).toHaveLength(2);
      for (const li of others) expect(within(li).queryByTestId("friend-voice")).toBeNull();
      // Bob leaves: the line goes.
      act(() => useVoicePresence.getState().apply("t.local", { room_id: "R1", channel_id: "V1", participants: [] }));
      expect(within(item).queryByTestId("friend-voice")).toBeNull();
    });

    it("shows nothing for a friend whose presence is offline (invisible), even in a viewable channel", async () => {
      // ben is in the viewable channel but has no presence: the node reports invisible users as offline.
      act(() => useVoicePresence.getState().apply("t.local", { room_id: "R1", channel_id: "V1", participants: [vp("anna"), vp("ben")] }));
      renderWithProviders(<FriendsPage />);
      const anna = (await screen.findByText("anna@t.local")).closest("li")!;
      const ben = (await screen.findByText("ben@t.local")).closest("li")!;
      await waitFor(() => expect(within(anna).getByTestId("friend-voice")).toHaveTextContent("Lounge"));
      expect(within(ben).queryByTestId("friend-voice")).toBeNull();
      const u = userEvent.setup();
      await u.click(within(ben).getByRole("button", { name: "Optionen für BEN" }));
      expect(within(screen.getByTestId("friend-menu")).queryByRole("menuitem", { name: /betreten/ })).toBeNull();
      await u.keyboard("{Escape}");
      // ben appears (online): the line shows; invisible again (reported offline): it goes.
      act(() => usePresence.getState().apply(online("ben")));
      await waitFor(() => expect(within(ben).getByTestId("friend-voice")).toHaveTextContent("Gilde / Lounge"));
      act(() => usePresence.getState().apply({ ...online("ben"), status: "offline" }));
      expect(within(ben).queryByTestId("friend-voice")).toBeNull();
    });

    it("the friend's menu (⋯ or right-click) joins their channel the way the channel list does", async () => {
      act(() => useVoicePresence.getState().apply("t.local", { room_id: "R1", channel_id: "V1", participants: [vp("anna")] }));
      renderWithProviders(<FriendsPage />);
      const item = (await screen.findByText("anna@t.local")).closest("li")!;
      await waitFor(() => expect(within(item).getByTestId("friend-voice")).toHaveTextContent("Lounge"));
      const u = userEvent.setup();
      const button = within(item).getByRole("button", { name: "Optionen für ANNA" });
      expect(button).toHaveAttribute("aria-haspopup", "menu");
      await u.click(button);
      const menu = screen.getByTestId("friend-menu");
      await u.click(within(menu).getByRole("menuitem", { name: "Lounge betreten" }));
      await waitFor(() => expect(voice.joinVoice).toHaveBeenCalledWith({ domain: "t.local", roomId: "R1", channelId: "V1" }, { canCreate: true }));
      // Without voice there is no join entry; the menu still has the friend's actions.
      act(() => useVoicePresence.getState().apply("t.local", { room_id: "R1", channel_id: "V1", participants: [] }));
      fireEvent.contextMenu(item, { clientX: 5, clientY: 5 });
      const again = screen.getByTestId("friend-menu");
      expect(within(again).queryByRole("menuitem", { name: /betreten/ })).toBeNull();
      expect(within(again).getByRole("menuitem", { name: "Nachricht" })).toBeInTheDocument();
    });
  });

  describe("invite to room", () => {
    const detail = (id: string, name: string, perms: bigint, isOwner = false) => ({ id, name, description: "", channels: [{ id: `${id}T`, kind: "text", name: "general" }], read_states: [], roles: [], overrides: [], my_permissions: perms.toString(), my_roles: [], is_owner: isOwner, member_count: 2 });
    const setup = (direct: (init: RequestInit) => { status?: number; body: unknown }) => {
      useVoicePresence.getState().reset();
      useToasts.setState({ toasts: [] });
      useAuth.setState({ token: "t", user: { ...user("u0", "me"), email: null, email_verified: false, has_identity_key: true } });
      return mockFetch({
        "/rooms/R1/invites/direct": direct,
        "/rooms/R1": { body: detail("R1", "Gilde", Permission.CREATE_INVITES | Permission.SEND_MESSAGES) },
        "/rooms/R2": { body: detail("R2", "Lesesaal", Permission.SEND_MESSAGES) },
        "/rooms": { body: [{ id: "R1", name: "Gilde", description: "" }, { id: "R2", name: "Lesesaal", description: "" }] },
        "/users/me/blocks": { body: [] },
        "/users/me/friends": { body: { friends: [{ user: user("u1", "anna"), since: "" }], incoming: [], outgoing: [], blocked: [] } },
      });
    };
    const openInviteMenu = async () => {
      renderWithProviders(<FriendsPage />);
      const item = (await screen.findByText("anna@t.local")).closest("li")!;
      const u = userEvent.setup();
      await u.click(within(item).getByRole("button", { name: "Optionen für ANNA" }));
      const menu = screen.getByTestId("friend-menu");
      const sub = await within(menu).findByRole("menuitem", { name: "Einladen in Raum" });
      expect(sub).toHaveAttribute("aria-haspopup", "menu");
      await u.click(sub);
      return { u, submenu: screen.getByTestId("context-submenu") };
    };

    it("lists only the rooms where the user may create invites and sends a direct invite to the friend", async () => {
      const calls = setup(() => ({ status: 202, body: { invite: { code: "c", room_id: "R1", uses: 0, max_uses: 1, expires_at: null, created_at: "", user: "anna@t.local" } } }));
      const { u, submenu } = await openInviteMenu();
      expect(within(submenu).queryByRole("menuitem", { name: "Lesesaal" })).toBeNull();
      await u.click(within(submenu).getByRole("menuitem", { name: "Gilde" }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith("/rooms/R1/invites/direct") && c.init.method === "POST")).toBe(true));
      const sent = calls.find((c) => c.url.endsWith("/rooms/R1/invites/direct"))!;
      expect(JSON.parse(String(sent.init.body))).toEqual({ user: "anna@t.local" });
      // An action, not a state: the menu closes.
      expect(screen.queryByTestId("friend-menu")).toBeNull();
      await waitFor(() => expect(useToasts.getState().toasts.map((x) => [x.kind, x.title])).toContainEqual(["info", "Einladung in Gilde an ANNA gesendet"]));
    });

    it("shows the node's refusal (already a member) as an error toast", async () => {
      setup(() => ({ status: 409, body: { type: "x", title: "Conflict", status: 409, code: "invite.already_member", detail: "Already a member of this room" } }));
      const { u, submenu } = await openInviteMenu();
      await u.click(within(submenu).getByRole("menuitem", { name: "Gilde" }));
      await waitFor(() => expect(useToasts.getState().toasts.find((x) => x.kind === "error")).toMatchObject({ title: "Einladung nicht gesendet", detail: "Diese Person ist bereits Mitglied des Raums" }));
    });

    it("has no submenu when no room allows inviting", async () => {
      setup(() => ({ status: 500, body: null }));
      mockFetch({
        "/rooms/R2": { body: detail("R2", "Lesesaal", Permission.SEND_MESSAGES) },
        "/rooms": { body: [{ id: "R2", name: "Lesesaal", description: "" }] },
        "/users/me/blocks": { body: [] },
        "/users/me/friends": { body: { friends: [{ user: user("u1", "anna"), since: "" }], incoming: [], outgoing: [], blocked: [] } },
      });
      renderWithProviders(<FriendsPage />);
      const item = (await screen.findByText("anna@t.local")).closest("li")!;
      fireEvent.contextMenu(item, { clientX: 5, clientY: 5 });
      const menu = screen.getByTestId("friend-menu");
      await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Nachricht" })).toBeInTheDocument());
      await new Promise((r) => setTimeout(r, 50));
      expect(within(menu).queryByRole("menuitem", { name: "Einladen in Raum" })).toBeNull();
    });
  });
});
