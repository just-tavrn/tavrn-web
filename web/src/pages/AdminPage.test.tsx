// SPDX-License-Identifier: Apache-2.0
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router";
import { AdminPage } from "./AdminPage";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";

const admin = { id: "a1", username: "root", domain: "t.local", address: "root@t.local", display_name: "Root", kind: "user", is_node_admin: true, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const bob = { id: "u2", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", disabled: false, email: null, email_verified: false };

describe("AdminPage: reset second factor", () => {
  it("asks for confirmation, calls the admin route and shows the audit entry", async () => {
    useAuth.setState({ token: "acc", user: admin });
    const calls = mockFetch({
      "/admin/users/u2/second-factor/reset": { body: {} },
      "/admin/audit-log": { body: [{ id: "e1", action: "admin.second_factor_reset", target: "bob@t.local", actor_id: "a1", created_at: "2026-10-04T12:00:00Z", meta: {}, reason: "" }] },
      "/admin/users": { body: [admin, bob] },
    });
    renderWithProviders(
      <Routes>
        <Route path="/admin/:tab?" element={<AdminPage />} />
      </Routes>,
      { route: "/admin/users" },
    );
    const row = (await screen.findByText("bob@t.local")).closest("li")!;
    const u = userEvent.setup();
    await u.click(within(row).getByRole("button", { name: "Zweiten Faktor zurücksetzen" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("bob@t.local");
    const confirm = within(dialog).getByRole("button", { name: "Zweiten Faktor zurücksetzen" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("Bestätigung"), "bob");
    await u.click(confirm);
    expect(await within(row).findByTestId("reset-2fa-audit")).toHaveTextContent("admin.second_factor_reset → bob@t.local");
    expect(calls.some((c) => c.url.endsWith("/admin/users/u2/second-factor/reset") && c.init.method === "POST")).toBe(true);
    // Not offered for the admin's own account.
    const own = screen.getByText("root@t.local").closest("li")!;
    expect(within(own).queryByRole("button", { name: "Zweiten Faktor zurücksetzen" })).not.toBeInTheDocument();
  });
});

describe("AdminPage: federation peers (FEDERATION.md §9)", () => {
  const record = {
    version: 1,
    result: "fail",
    checked_at: "2026-10-05T10:00:00Z",
    software: "tavrn-node/0.0.1",
    duration_ms: 812,
    history: [{ checked_at: "2026-10-05T10:00:00Z", result: "fail" }],
    checks: [
      { id: "wk.fetch", result: "pass", hard: false, detail: null },
      { id: "token.bad_signature", result: "fail", hard: true, detail: "accepted (200)" },
      { id: "rate.limits", result: "warn", hard: false, detail: "no 429 after 65 invalid logins in a minute" },
    ],
  };
  const peer = (over: Record<string, unknown>) => ({
    domain: "b.test",
    status: "ok",
    conformance: "unknown",
    checked_at: null,
    hard_failures: 0,
    soft_failures: 0,
    violations: 0,
    blocked_at: null,
    blocked_reason: null,
    fetched_at: "2026-10-05T09:00:00Z",
    record: null,
    recent_violations: [],
    ...over,
  });
  const row = () => screen.getByText("b.test").closest("li")!;

  it("lists peers, runs a check, shows the results and blocks and unblocks", async () => {
    useAuth.setState({ token: "acc", user: admin });
    let current: Record<string, unknown> = peer({});
    const checked = peer({ conformance: "fail", status: "blocked_auto", checked_at: record.checked_at, hard_failures: 1, soft_failures: 1, blocked_reason: "conformance check failed: token.bad_signature", record });
    const calls = mockFetch({
      "/admin/federation/peers/b.test/check": () => ((current = checked), { body: current }),
      "/admin/federation/peers/b.test/unblock": () => ((current = { ...current, status: "ok", blocked_reason: null }), { body: current }),
      "/admin/federation/peers/b.test/block": () => ((current = { ...current, status: "blocked", blocked_reason: "" }), { body: current }),
      "/admin/federation/peers": () => ({ body: [current] }),
    });
    renderWithProviders(
      <Routes>
        <Route path="/admin/:tab?" element={<AdminPage />} />
      </Routes>,
      { route: "/admin/federation" },
    );
    await screen.findByText("b.test");
    expect(within(row()).getByTestId("peer-conformance")).toHaveTextContent("nicht geprüft");
    expect(within(row()).getByTestId("peer-status")).toHaveTextContent("föderiert");
    const u = userEvent.setup();
    await u.click(within(row()).getByRole("button", { name: "Prüfung starten" }));
    const results = await screen.findByTestId("conformance-results");
    expect(within(results).getAllByTestId("conformance-check").map((c) => `${c.dataset.check}=${c.dataset.result}`)).toEqual(["wk.fetch=pass", "token.bad_signature=fail", "rate.limits=warn"]);
    expect(results).toHaveTextContent("accepted (200)");
    expect(within(row()).getByTestId("peer-conformance")).toHaveTextContent("nicht bestanden");
    expect(within(row()).getByTestId("peer-status")).toHaveTextContent("automatisch gesperrt");
    expect(row()).toHaveTextContent("conformance check failed: token.bad_signature");
    expect(row()).toHaveTextContent("1 harte Fehler · 1 Warnungen · 0 Verstöße");

    await u.click(within(row()).getByRole("button", { name: "Entsperren" }));
    await u.click(await within(row()).findByRole("button", { name: "Sperren" }));
    await within(row()).findByRole("button", { name: "Entsperren" });
    expect(within(row()).getByTestId("peer-status")).toHaveAttribute("data-status", "blocked");
    const posts = calls.filter((c) => c.init.method === "POST").map((c) => c.url.replace(/^.*\/api\/v1/, ""));
    expect(posts).toEqual(["/admin/federation/peers/b.test/check", "/admin/federation/peers/b.test/unblock", "/admin/federation/peers/b.test/block"]);
  });

  it("checks a node by domain and shows an empty list", async () => {
    useAuth.setState({ token: "acc", user: admin });
    const calls = mockFetch({ "/admin/federation/peers/c.test/check": { body: peer({ domain: "c.test" }) }, "/admin/federation/peers": { body: [] } });
    renderWithProviders(
      <Routes>
        <Route path="/admin/:tab?" element={<AdminPage />} />
      </Routes>,
      { route: "/admin/federation" },
    );
    expect(await screen.findByText("Noch keine anderen Knoten bekannt.")).toBeInTheDocument();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Knoten prüfen"), " C.test ");
    await u.click(screen.getByRole("button", { name: "Knoten prüfen" }));
    await screen.findByText("Noch keine anderen Knoten bekannt.");
    expect(calls.some((c) => c.url.endsWith("/admin/federation/peers/c.test/check") && c.init.method === "POST")).toBe(true);
  });
});

describe("AdminPage: reports about other nodes (FEDERATION.md §9.2)", () => {
  it("shows the count per node, the reports, delists the node and dismisses the reports", async () => {
    useAuth.setState({ token: "acc", user: admin });
    let summary = [{ domain: "b.test", reports: 3, reporters: 2, recent: 3, last_at: "2026-10-05T10:00:00Z", delisted: false }];
    const entries = [{ id: "r1", domain: "b.test", room_id: "01J9ZK3G5M8Q2W4E6R8T0Y2V01", check: "spam", detail: "Werbung <b>überall</b>", reporter: "bob@t.local", created_at: "2026-10-05T10:00:00Z" }];
    const calls = mockFetch({
      "/admin/directory/reports/b.test": (init) => (init.method === "DELETE" ? ((summary = []), { body: {} }) : { body: entries }),
      "/admin/directory/reports": () => ({ body: summary }),
      "/admin/directory/nodes/b.test": () => ((summary = summary.map((s) => ({ ...s, delisted: true }))), { body: {} }),
      "/admin/federation/peers": { body: [] },
    });
    renderWithProviders(
      <Routes>
        <Route path="/admin/:tab?" element={<AdminPage />} />
      </Routes>,
      { route: "/admin/federation" },
    );
    const row = await screen.findByTestId("report-node");
    expect(within(row).getByTestId("report-count")).toHaveTextContent("3 Meldungen");
    const u = userEvent.setup();
    await u.click(within(row).getByRole("button", { name: "Meldungen anzeigen" }));
    const entry = await within(row).findByTestId("report-entry");
    expect(entry).toHaveTextContent("spam");
    expect(entry).toHaveTextContent("bob@t.local");
    expect(entry).toHaveTextContent("Werbung <b>überall</b>");
    expect(entry.querySelector("b")).toBeNull();
    await u.click(within(row).getByRole("button", { name: "Aus dem Verzeichnis entfernen" }));
    expect(await within(row).findByText("aus dem Verzeichnis entfernt")).toBeInTheDocument();
    await u.click(within(row).getByRole("button", { name: "Verwerfen" }));
    expect(await screen.findByText("Keine Meldungen.")).toBeInTheDocument();
    const deletes = calls.filter((c) => c.init.method === "DELETE").map((c) => c.url.replace(/^.*\/api\/v1/, ""));
    expect(deletes).toEqual(["/admin/directory/nodes/b.test", "/admin/directory/reports/b.test"]);
  });
});
