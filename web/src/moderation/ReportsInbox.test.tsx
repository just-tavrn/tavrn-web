// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModerationReport, TavrnApi } from "@tavrn/sdk";
import { renderWithProviders } from "../test/render";
import { useLocale } from "../i18n";
import { ReportsInbox } from "./ReportsInbox";

const base: ModerationReport = {
  id: "R1",
  source: "user",
  scope: "room",
  kind: "message",
  room_id: "ROOM",
  room_name: "Guild",
  conversation_id: "C1",
  conversation_kind: "channel",
  node: null,
  message_id: "M1",
  message_exists: true,
  target: null,
  target_address: "mallory@b.example",
  reporter: { id: "U1", username: "alice", domain: "a.example", address: "alice@a.example", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "" } as unknown as ModerationReport["reporter"],
  category: "spam",
  detail: "Selling followers",
  snapshot: { author: "mallory@b.example", created_at: "2026-10-12T09:00:00Z", text: "Buy followers", attachments: [] },
  evidence: null,
  evidence_count: 0,
  evidence_source: null,
  status: "open",
  assignee: null,
  note: "",
  actions: [],
  forwarded: null,
  origin: null,
  created_at: "2026-10-12T09:01:00Z",
  updated_at: "2026-10-12T09:01:00Z",
  resolved_at: null,
};

const forwardedIn: ModerationReport = {
  ...base,
  id: "R2",
  source: "forward",
  scope: "node",
  room_id: null,
  room_name: null,
  conversation_id: null,
  conversation_kind: null,
  node: "c.example",
  target_address: "bob@a.example",
  reporter: null,
  origin: { node: "c.example", report_id: "X9", reporter: "anon-Qx7", reported_at: "2026-10-11T08:00:00Z" },
};

function client(reports: ModerationReport[]) {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const forward = vi.fn(async (id: string) => ({ ...byId.get(id)!, forwarded: { node: "b.example", at: "2026-10-12T10:00:00Z", by: "admin@a.example" } }));
  const api = {
    reports: {
      admin: vi.fn(async () => ({ reports, open: reports.length })),
      get: vi.fn(async (id: string) => byId.get(id)!),
      forward,
    },
  } as unknown as TavrnApi;
  return { api, forward };
}

describe("ReportsInbox: forwarding (MODERATION.md §1.6)", () => {
  beforeEach(() => useLocale.setState({ locale: "en" }));
  afterEach(() => useLocale.setState({ locale: "de" }));

  it("node admins forward a report about a user of another node after a confirmation", async () => {
    const { api, forward } = client([base]);
    renderWithProviders(<ReportsInbox client={api} mode={{ kind: "admin", forwardFrom: "a.example" }} meId="ADMIN" />);
    const u = userEvent.setup();
    await u.click(await screen.findByTestId("report-row"));
    const button = await screen.findByTestId("report-forward");
    expect(button).toHaveTextContent("Forward to the user's home node");
    await u.click(button);
    const dialog = screen.getByRole("dialog", { name: "Forward the report to b.example?" });
    expect(dialog).toHaveTextContent("pseudonym");
    expect(forward).not.toHaveBeenCalled();
    await u.click(within(dialog).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(forward).toHaveBeenCalledWith("R1"));
  });

  it("offers nothing without reports.v2, for local users or once forwarded", async () => {
    const forwarded = { ...base, id: "R3", forwarded: { node: "b.example", at: "2026-10-12T10:00:00Z", by: "admin@a.example" } };
    const local = { ...base, id: "R4", target_address: "bob@a.example" };
    const { api } = client([forwarded, local]);
    const { unmount } = renderWithProviders(<ReportsInbox client={api} mode={{ kind: "admin", forwardFrom: "a.example" }} meId="ADMIN" />);
    const u = userEvent.setup();
    const rows = await screen.findAllByTestId("report-row");
    expect(within(rows[0]!).getByTestId("report-forwarded-badge")).toHaveTextContent("Forwarded to b.example");
    await u.click(rows[0]!);
    expect(await screen.findByTestId("report-forwarded")).toHaveTextContent("admin@a.example");
    expect(screen.queryByTestId("report-forward")).toBeNull();
    await u.click(rows[1]!);
    await screen.findByTestId("report-detail");
    expect(screen.queryByTestId("report-forward")).toBeNull();
    unmount();
    const other = client([base]);
    renderWithProviders(<ReportsInbox client={other.api} mode={{ kind: "admin", forwardFrom: null }} meId="ADMIN" />);
    await u.click(await screen.findByTestId("report-row"));
    await screen.findByTestId("report-detail");
    expect(screen.queryByTestId("report-forward")).toBeNull();
  });

  it("marks reports forwarded by another node with their origin and the reporter's pseudonym", async () => {
    const { api } = client([forwardedIn]);
    renderWithProviders(<ReportsInbox client={api} mode={{ kind: "admin", forwardFrom: "a.example" }} meId="ADMIN" />);
    const row = await screen.findByTestId("report-row");
    expect(within(row).getByTestId("report-origin-badge")).toHaveTextContent("Forwarded from c.example");
    expect(row).toHaveTextContent("reported by anon-Qx7 (on c.example)");
    await userEvent.setup().click(row);
    expect(await screen.findByTestId("report-reporter")).toHaveTextContent("anon-Qx7");
    expect(screen.getByTestId("report-origin")).toHaveTextContent("c.example");
    expect(screen.queryByTestId("report-forward")).toBeNull();
  });
});
