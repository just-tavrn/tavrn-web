// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { AdminPage } from "../AdminPage";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";
import { adminDisabled } from "./ApplicationsTab";
import { buildRights } from "./SsoGroupMapTab";

const admin = { id: "a1", username: "root", domain: "t.local", address: "root@t.local", display_name: "Root", kind: "user", is_node_admin: true, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const bot = { id: "b1", username: "wetter", domain: "t.local", address: "wetter@t.local", display_name: "Wetter", kind: "bot", application_id: "01J9AAAAAAAAAAAAAAAAAAAAAA", created_at: "" };
const app = { id: "01J9AAAAAAAAAAAAAAAAAAAAAA", ref: "t.local/01J9AAAAAAAAAAAAAAAAAAAAAA", name: "Wetter", bot, owner: "alice@t.local", public: true, tokens: 2, installations: 3, disabled: false, disabled_reason: null, created_at: "2026-10-01T10:00:00Z" };
const block = { bot: "spam@evil.example", reason: "Spam", created_by: "root@t.local", created_at: "2026-10-02T10:00:00Z" };
const ROOM = "01J9RRRRRRRRRRRRRRRRRRRRRR";
const ROLE = "01J9LLLLLLLLLLLLLLLLLLLLLL";

function renderAdmin(route: string) {
  useAuth.setState({ token: "acc", user: admin });
  return renderWithProviders(
    <Routes>
      <Route path="/admin/:tab?" element={<AdminPage />} />
    </Routes>,
    { route },
  );
}

const nodeInfo = (capabilities: string[]) => ({ body: { name: "t", domain: "t.local", description: "", capabilities } });

describe("admin application helpers", () => {
  it("only an admin's disabling can be undone with Enable", () => {
    expect(adminDisabled({ disabled: false, disabled_reason: null })).toBe(false);
    expect(adminDisabled({ disabled: true, disabled_reason: "admin" })).toBe(true);
    expect(adminDisabled({ disabled: true, disabled_reason: "blocked" })).toBe(false);
    expect(adminDisabled({ disabled: true, disabled_reason: "owner_disabled" })).toBe(false);
  });

  it("builds rights without unset fields", () => {
    expect(buildRights({ nodeAdmin: false, roomCreation: "", appCreation: "", rooms: [] })).toEqual({});
    expect(buildRights({ nodeAdmin: true, roomCreation: "3", appCreation: "0", rooms: [{ room: ROOM, roles: [ROLE] }] })).toEqual({ node_admin: true, room_creation: 3, app_creation: 0, rooms: [{ room: ROOM, roles: [ROLE] }] });
  });
});

describe("AdminPage: applications tab", () => {
  it("lists applications, disables one, blocks a bot and shows errors, unblocks", async () => {
    let blocks = [block];
    const calls = mockFetch({
      "/api/v1/node": nodeInfo([]),
      "/admin/applications/blocks": (init) => {
        if (init.method === "POST") {
          const body = JSON.parse(String(init.body));
          if (body.bot === "alice@t.local") return { status: 400, body: { code: "app.not_a_bot", status: 400, title: "Bad request", detail: "This address is not a bot", type: "x" } };
          const created = { bot: body.bot, reason: body.reason ?? "", created_by: "root@t.local", created_at: "2026-10-03T10:00:00Z" };
          blocks = [created, ...blocks];
          return { status: 201, body: created };
        }
        if (init.method === "DELETE") {
          blocks = [];
          return { body: {} };
        }
        return { body: blocks };
      },
      "/admin/applications/commands": { body: [] },
      "/admin/applications": (init) => (init.method === "PATCH" ? { body: {} } : { body: [app] }),
    });
    renderAdmin("/admin/applications");
    const list = await screen.findByTestId("admin-app-list");
    const row = await within(list).findByTestId("admin-app-row");
    expect(row).toHaveTextContent("Wetter");
    expect(row).toHaveTextContent("wetter@t.local");
    expect(row).toHaveTextContent("alice@t.local");
    expect(within(row).getByTestId("admin-app-stats")).toHaveTextContent("2 Tokens · 3 Installationen");
    expect(within(row).getByTestId("bot-badge")).toBeInTheDocument();

    const u = userEvent.setup();
    await u.click(within(row).getByTestId("admin-app-toggle"));
    const patch = calls.find((c) => c.init.method === "PATCH");
    expect(patch?.url).toContain(`/admin/applications/${app.id}`);
    expect(JSON.parse(String(patch!.init.body))).toEqual({ disabled: true });

    const blockList = screen.getByTestId("admin-app-block-list");
    expect(await within(blockList).findByText("spam@evil.example")).toBeInTheDocument();
    expect(blockList).toHaveTextContent("Spam");

    await u.type(screen.getByTestId("admin-app-block-bot"), "alice@t.local");
    await u.click(screen.getByTestId("admin-app-block-submit"));
    expect(await screen.findByTestId("admin-app-block-error")).toHaveTextContent("Diese Adresse ist kein Bot.");

    await u.clear(screen.getByTestId("admin-app-block-bot"));
    await u.type(screen.getByTestId("admin-app-block-bot"), "evil@b.example");
    await u.type(screen.getByTestId("admin-app-block-reason"), "Phishing");
    await u.click(screen.getByTestId("admin-app-block-submit"));
    const post = calls.filter((c) => c.init.method === "POST").at(-1)!;
    expect(JSON.parse(String(post.init.body))).toEqual({ bot: "evil@b.example", reason: "Phishing" });
    expect(await within(blockList).findByText("evil@b.example")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-app-block-error")).toBeNull();

    await u.click(within(blockList).getAllByTestId("admin-app-unblock")[0]!);
    const del = calls.find((c) => c.init.method === "DELETE");
    expect(del?.url).toContain("/admin/applications/blocks/evil%40b.example");
    expect(await within(blockList).findByText("Keine blockierten Bots.")).toBeInTheDocument();
  });

  it("deletes an application only after typing the bot's name", async () => {
    const calls = mockFetch({
      "/api/v1/node": nodeInfo([]),
      "/admin/applications/blocks": { body: [] },
      "/admin/applications/commands": { body: [] },
      "/admin/applications": (init) => (init.method === "DELETE" ? { body: {} } : { body: [{ ...app, disabled: true, disabled_reason: "admin" }] }),
    });
    renderAdmin("/admin/applications");
    const row = await screen.findByTestId("admin-app-row");
    expect(within(row).getByTestId("admin-app-disabled")).toHaveTextContent("durch einen Admin");
    expect(within(row).getByTestId("admin-app-toggle")).toHaveTextContent("Aktivieren");
    const u = userEvent.setup();
    await u.click(within(row).getByTestId("admin-app-delete"));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Löschen" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("Bestätigung"), "wetter");
    await u.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.init.method === "DELETE" && c.url.endsWith(`/admin/applications/${app.id}`))).toBe(true));
  });

  it("lists command definitions per state and approves or rejects them (APPLICATIONS.md §5.2)", async () => {
    const def = (name: string, hash: string, state: string) => ({ application: app.ref, command: { id: `c-${name}`, name, description: `${name} description`, args: [], default_permissions: null, dm_allowed: false }, definition_hash: hash, state });
    const remote = { ...def("ping", "h3", "pending"), application: "b.example/01J9BBBBBBBBBBBBBBBBBBBBBB" };
    const calls = mockFetch({
      "/api/v1/node": nodeInfo([]),
      "/admin/applications/blocks": { body: [] },
      "/admin/applications/commands/approval": { body: { required: true } },
      "/admin/applications/commands/approve": { status: 204, body: {} },
      "/admin/applications/commands/reject": { status: 204, body: {} },
      "/admin/applications/commands?state=approved": { body: [def("weather", "h2", "approved")] },
      "/admin/applications/commands?state=rejected": { body: [] },
      "/admin/applications/commands": { body: [def("weather", "h1", "pending"), def("forecast", "h4", "pending"), remote] },
      "/admin/applications": { body: [app] },
    });
    renderAdmin("/admin/applications");
    await waitFor(() => expect(screen.getByTestId("command-approval-filter")).toHaveAttribute("data-required", "true"));
    expect(screen.getByText(/TAVRN_APP_COMMANDS_REQUIRE_APPROVAL=true/)).toBeInTheDocument();
    const groups = await screen.findAllByTestId("command-approval-app");
    expect(groups.map((g) => g.getAttribute("data-application"))).toEqual([app.ref, "b.example/01J9BBBBBBBBBBBBBBBBBBBBBB"]);
    expect(groups[0]).toHaveTextContent("Wetter");
    expect(within(groups[0]!).getAllByTestId("command-approval-row").map((r) => r.getAttribute("data-command"))).toEqual(["weather", "forecast"]);
    const u = userEvent.setup();
    await u.click(within(within(groups[0]!).getAllByTestId("command-approval-row")[0]!).getByTestId("command-approval-approve"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/admin/applications/commands/approve"))).toBe(true));
    const approve = calls.find((c) => c.url.endsWith("/commands/approve"))!;
    expect(JSON.parse(String(approve.init.body))).toEqual({ application: app.ref, hashes: ["h1"] });
    await u.click(within(groups[1]!).getByTestId("command-approval-reject"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/commands/reject"))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/commands/reject"))!.init.body))).toEqual({ application: "b.example/01J9BBBBBBBBBBBBBBBBBBBBBB", hashes: ["h3"] });
    await u.click(within(groups[0]!).getByTestId("command-approval-approve-all"));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/commands/approve")).length).toBe(2));
    expect(JSON.parse(String(calls.filter((c) => c.url.endsWith("/commands/approve"))[1]!.init.body)).hashes).toEqual(["h1", "h4"]);
    // The approved list offers only "reject".
    await u.click(screen.getByTestId("command-approval-state-approved"));
    const approved = await screen.findByText("/weather");
    const row = approved.closest("[data-testid='command-approval-row']") as HTMLElement;
    expect(row).toHaveAttribute("data-state", "approved");
    expect(within(row).queryByTestId("command-approval-approve")).toBeNull();
    expect(within(row).getByTestId("command-approval-reject")).toBeInTheDocument();
    await u.click(screen.getByTestId("command-approval-state-rejected"));
    expect(await screen.findByText("Keine Befehle in dieser Liste.")).toBeInTheDocument();
  });

  it("shows the application of a report", async () => {
    mockFetch({
      "/api/v1/node": nodeInfo([]),
      "/admin/federation/peers": { body: [] },
      "/admin/directory/reports/t.local": { body: [{ id: "r1", domain: "t.local", check: "spam", detail: "Werbung", reporter: "bob@t.local", room_id: null, application: `t.local/${app.id}`, created_at: "2026-10-02T10:00:00Z" }] },
      "/admin/directory/reports": { body: [{ domain: "t.local", reports: 1, reporters: 1, recent: 1, last_at: "2026-10-02T10:00:00Z", delisted: false }] },
    });
    renderAdmin("/admin/federation");
    const node = await screen.findByTestId("report-node");
    await userEvent.setup().click(within(node).getByRole("button", { name: /anzeigen/i }));
    expect(await screen.findByTestId("report-application")).toHaveTextContent(`Anwendung: t.local/${app.id}`);
  });
});

describe("AdminPage: SSO group map tab", () => {
  it("is hidden without the sso.oidc capability", async () => {
    mockFetch({ "/api/v1/node": nodeInfo(["unfurl"]), "/admin/overview": { status: 500, body: {} } });
    renderAdmin("/admin/overview");
    await screen.findByTestId("admin-tab-applications");
    await waitFor(() => expect(screen.queryByTestId("admin-tab-sso")).toBeNull());
  });

  it("adds, edits and removes mappings, saving the whole map", async () => {
    let doc = { map: { staff: { room_creation: 5 } } as Record<string, unknown>, fixed: false, sync: "add" };
    const calls = mockFetch({
      "/api/v1/node": nodeInfo(["sso.oidc"]),
      "/admin/sso/group-map": (init) => {
        if (init.method === "PUT") doc = { ...doc, map: JSON.parse(String(init.body)).map };
        return { body: doc };
      },
      // Rooms and roles are picked by name (MODERATION.md: GET /admin/rooms).
      "/admin/rooms": { body: [{ id: ROOM, name: "Guild", owner: "alice@t.local", members: 3, roles: [{ id: ROLE, name: "Staff", position: 1 }] }] },
    });
    renderAdmin("/admin/sso");
    expect(await screen.findByTestId("admin-tab-sso")).toBeInTheDocument();
    const map = await screen.findByTestId("admin-sso-map");
    expect(within(map).getByTestId("admin-sso-mapping")).toHaveTextContent("Raum-Erstellungen: 5");

    const u = userEvent.setup();
    await u.type(screen.getByTestId("admin-sso-group"), "devs");
    await u.click(screen.getByTestId("admin-sso-node-admin"));
    await u.type(screen.getByTestId("admin-sso-app-creation"), "2");
    await waitFor(() => expect(within(screen.getByTestId("admin-sso-room-add")).getByRole("option", { name: /Guild/ })).toBeInTheDocument());
    await u.selectOptions(screen.getByTestId("admin-sso-room-add"), ROOM);
    const grant = await screen.findByTestId("admin-sso-room-grant");
    expect(grant).toHaveTextContent("Guild");
    await u.click(within(grant).getByLabelText("Staff"));
    await u.click(screen.getByTestId("admin-sso-add"));
    await waitFor(() => expect(within(map).getAllByTestId("admin-sso-mapping")).toHaveLength(2));
    const put = calls.filter((c) => c.init.method === "PUT").at(-1)!;
    expect(JSON.parse(String(put.init.body))).toEqual({ map: { staff: { room_creation: 5 }, devs: { node_admin: true, app_creation: 2, rooms: [{ room: ROOM, roles: [ROLE] }] } } });
    const devs = within(map).getAllByTestId("admin-sso-mapping").find((r) => r.dataset.group === "devs")!;
    expect(devs).toHaveTextContent("Knoten-Admin");
    expect(devs).toHaveTextContent("Guild");
    expect(devs).toHaveTextContent("Staff");
    expect(devs).not.toHaveTextContent(ROLE);
    expect(screen.getByTestId("admin-sso-group")).toHaveValue("");

    // Edit loads the mapping into the form; saving replaces it.
    await u.click(within(devs).getByTestId("admin-sso-edit"));
    expect(screen.getByTestId("admin-sso-group")).toHaveValue("devs");
    expect(screen.getByTestId("admin-sso-add")).toHaveTextContent("Zuordnung speichern");
    await u.click(screen.getByTestId("admin-sso-node-admin"));
    await u.click(screen.getByTestId("admin-sso-add"));
    await waitFor(() => expect(doc.map.devs).toEqual({ app_creation: 2, rooms: [{ room: ROOM, roles: [ROLE] }] }));

    await u.click(within(map).getByRole("button", { name: "Zuordnung staff entfernen" }));
    await waitFor(() => expect(within(map).getAllByTestId("admin-sso-mapping")).toHaveLength(1));
    expect(Object.keys(doc.map)).toEqual(["devs"]);
  });

  it("shows the offending entry of an invalid map", async () => {
    mockFetch({
      "/api/v1/node": nodeInfo(["sso.oidc"]),
      "/admin/sso/group-map": (init) =>
        init.method === "PUT" ? { status: 400, body: { code: "sso.group_map_invalid", status: 400, title: "Bad request", detail: "devs.rooms: 'x' is not a room id", type: "x" } } : { body: { map: {}, fixed: false, sync: "sync" } },
    });
    renderAdmin("/admin/sso");
    await screen.findByTestId("admin-sso-form");
    expect(screen.getByTestId("admin-sso-sync")).toHaveTextContent("sync");
    const u = userEvent.setup();
    await u.type(screen.getByTestId("admin-sso-group"), "devs");
    await u.click(screen.getByTestId("admin-sso-add"));
    expect(await screen.findByTestId("admin-sso-error")).toHaveTextContent("is not a room id");
  });

  it("is read-only with TAVRN_OIDC_GROUP_MAP", async () => {
    mockFetch({ "/api/v1/node": nodeInfo(["sso.oidc"]), "/admin/sso/group-map": { body: { map: { ops: { node_admin: true } }, fixed: true, sync: "add" } } });
    renderAdmin("/admin/sso");
    expect(await screen.findByTestId("admin-sso-fixed")).toHaveTextContent("TAVRN_OIDC_GROUP_MAP");
    expect(screen.getByTestId("admin-sso-mapping")).toHaveTextContent("ops");
    expect(screen.queryByTestId("admin-sso-form")).toBeNull();
    expect(screen.queryByTestId("admin-sso-remove")).toBeNull();
  });
});
