// SPDX-License-Identifier: Apache-2.0
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { AdminPage } from "../AdminPage";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";
import { formatLimit, toIso, toLocalInput } from "./EntitlementsTab";

const admin = { id: "a1", username: "root", domain: "t.local", address: "root@t.local", display_name: "Root", kind: "user", is_node_admin: true, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const keys = [
  { key: "rooms.max_owned", rule: "max", scope: "user", max: 1000000, node_default: 5 },
  { key: "upload.max_bytes", rule: "max", scope: "user", max: 1099511627776, node_default: 26214400 },
  { key: "attachments.retention_days", rule: "shortest_non_zero", scope: "room", max: 36500, node_default: 0 },
];
const gold = { id: "p1", name: "Gold", limits: { "rooms.max_owned": 20 }, grants: 1, created_by: "a1", created_at: "", updated_at: "" };
const grant = { id: "g1", subject: "user:u2", subject_kind: "user", subject_id: "u2", subject_label: "bob@t.local", plan_id: "p1", plan_name: "Gold", overrides: { "upload.max_bytes": 104857600 }, values: {}, expires_at: "2099-01-01T00:00:00.000Z", expired: false, note: "Abo 42", created_by: "a1", created_at: "", updated_at: "" };

function renderAdmin(route: string) {
  useAuth.setState({ token: "acc", user: admin });
  return renderWithProviders(
    <Routes>
      <Route path="/admin/:tab?" element={<AdminPage />} />
    </Routes>,
    { route },
  );
}

describe("entitlement helpers", () => {
  it("formats limits for humans", () => {
    const t = ((k: string) => ({ "entitlements.unlimited": "unbegrenzt", "entitlements.keep_forever": "für immer", "common.yes": "Ja", "common.no": "Nein" })[k] ?? k) as never;
    expect(formatLimit("rooms.max_owned", 0, t)).toBe("unbegrenzt");
    expect(formatLimit("attachments.retention_days", 0, t)).toBe("für immer");
    expect(formatLimit("upload.max_bytes", 104857600, t)).toBe("100.0 MB");
    expect(formatLimit("files_channels.enabled", 1, t, "flag")).toBe("Ja");
    expect(formatLimit("files_channels.internal", 0, t, "setting")).toBe("Nein");
    expect(formatLimit("files_channels.internal", 1, t)).toBe("Ja");
    expect(formatLimit("rooms.max_owned", 7, t)).toBe("7");
  });

  it("converts datetime-local values", () => {
    expect(toIso("")).toBeNull();
    expect(toIso("nonsense")).toBeNull();
    const iso = toIso("2030-05-01T12:30")!;
    expect(toLocalInput(iso)).toBe("2030-05-01T12:30");
  });
});

describe("AdminPage: entitlements tab", () => {
  it("lists plans and grants and creates a grant with plan, override and expiry", async () => {
    const calls = mockFetch({
      "/admin/entitlements/keys": { body: keys },
      "/admin/entitlements/plans": { body: [gold] },
      "/admin/entitlements/grants": (init) => (init.method === "POST" ? { status: 201, body: grant } : { body: [grant] }),
    });
    renderAdmin("/admin/entitlements");
    const plans = await screen.findByTestId("plan-list");
    expect(await within(plans).findByText("Gold")).toBeInTheDocument();
    expect(plans).toHaveTextContent("Eigene Räume: 20");
    const grants = screen.getByTestId("grant-list");
    expect(await within(grants).findByText("bob@t.local")).toBeInTheDocument();
    expect(grants).toHaveTextContent("Abo 42");
    expect(grants).toHaveTextContent("Upload-Größe: 100.0 MB");

    const u = userEvent.setup();
    const form = screen.getByTestId("grant-create");
    await u.type(within(form).getByLabelText("Empfänger"), "user:bob");
    await u.selectOptions(within(form).getByLabelText("Plan"), "p1");
    await u.selectOptions(within(form).getByLabelText("Grenze hinzufügen …"), "upload.max_bytes");
    const value = within(form).getByLabelText(/Upload-Größe/);
    await u.clear(value);
    await u.type(value, "5000");
    await u.type(within(form).getByLabelText("Läuft ab"), "2030-01-01T10:00");
    await u.click(within(form).getByRole("button", { name: "Freigabe anlegen" }));
    const post = calls.find((c) => c.url.endsWith("/admin/entitlements/grants") && c.init.method === "POST");
    expect(post).toBeDefined();
    const body = JSON.parse(String(post!.init.body));
    expect(body).toMatchObject({ subject: "user:bob", plan_id: "p1", overrides: { "upload.max_bytes": 5000 } });
    expect(body.expires_at).toBe(new Date("2030-01-01T10:00").toISOString());
  });

  it("creates a plan with limits", async () => {
    const calls = mockFetch({
      "/admin/entitlements/keys": { body: keys },
      "/admin/entitlements/plans": (init) => (init.method === "POST" ? { status: 201, body: gold } : { body: [] }),
      "/admin/entitlements/grants": { body: [] },
    });
    renderAdmin("/admin/entitlements");
    expect(await screen.findByText("Noch keine Pläne.")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Name des Plans"), "Gold");
    const section = screen.getByLabelText("Name des Plans").closest("form")!;
    await u.selectOptions(within(section).getByLabelText("Grenze hinzufügen …"), "rooms.max_owned");
    const value = within(section).getByLabelText(/Eigene Räume/);
    await u.clear(value);
    await u.type(value, "20");
    await u.click(within(section).getByRole("button", { name: "Plan anlegen" }));
    const post = calls.find((c) => c.url.endsWith("/admin/entitlements/plans") && c.init.method === "POST");
    expect(JSON.parse(String(post!.init.body))).toEqual({ name: "Gold", limits: { "rooms.max_owned": 20 } });
  });
});

describe("AdminPage: API tokens tab", () => {
  it("creates a token with scopes and shows the secret once; lists without secrets", async () => {
    const token = { id: "t1", name: "Billing", scopes: ["entitlements", "users:read"], created_by: "a1", expires_at: null, last_used_at: null, created_at: "2026-10-06T10:00:00Z", expired: false };
    const calls = mockFetch({
      "/admin/tokens": (init) => (init.method === "POST" ? { status: 201, body: { ...token, secret: "tavrn_adm_X.secret" } } : { body: [token] }),
    });
    renderAdmin("/admin/tokens");
    const list = await screen.findByTestId("admin-token-list");
    expect(await within(list).findByText("Billing")).toBeInTheDocument();
    expect(list).toHaveTextContent("nie benutzt");
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Name des Tokens"), "Billing");
    await u.click(screen.getByRole("checkbox", { name: /users:read/ }));
    await u.click(screen.getByRole("button", { name: "Token erzeugen" }));
    expect(await screen.findByTestId("admin-token-secret-value")).toHaveTextContent("tavrn_adm_X.secret");
    const post = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(post!.init.body))).toEqual({ name: "Billing", scopes: ["entitlements", "users:read"], expires_at: null });
    await u.click(screen.getByRole("button", { name: "Fertig" }));
    expect(screen.queryByTestId("admin-token-secret")).toBeNull();
    expect(screen.queryByText(/tavrn_adm_X/)).toBeNull();
  });
});
