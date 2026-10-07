// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthResponse } from "@tavrn/sdk";
import { DeleteAccountSection, MyDataSection, exportFilename } from "./AccountDataSections";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const user = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const session = { status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "01J9ZK3G5M8Q2W4E6R8T0Y2VA1", recovery_code_used: false } as unknown as AuthResponse;

beforeEach(() => {
  useAuth.getState().logout();
  useAuth.getState().setSession(session);
});

describe("account data sections", () => {
  it("names the export file after the account and the day", () => {
    expect(exportFilename("alice", new Date("2026-10-06T12:00:00Z"))).toBe("tavrn-export-alice-2026-10-06.json");
  });

  it("shows the summary of the node's data", async () => {
    mockFetch({
      "/api/v1/users/me/data": { body: { address: "alice@t.local", created_at: "2026-01-01T00:00:00Z", categories: [{ key: "messages", count: 3, since: "2026-01-02T00:00:00Z" }, { key: "blocks", count: 0, since: null }], nodes: ["b.test"], applications: [{ name: "Helper", relation: "room", room: "Hall" }], retention: { account_delete_grace_days: 30, attachment_retention_days: 0 } } },
    });
    renderWithProviders(<MyDataSection />);
    await userEvent.setup().click(screen.getByTestId("my-data-show"));
    expect(await screen.findByTestId("data-category-messages")).toHaveTextContent("3");
    expect(screen.queryByTestId("data-category-blocks")).toBeNull();
    expect(screen.getByTestId("my-data-summary")).toHaveTextContent("b.test");
    expect(screen.getByTestId("my-data-summary")).toHaveTextContent("Helper (Hall)");
  });

  it("deletes only after typing the username and sends the message option", async () => {
    const calls = mockFetch({ "/api/v1/users/me": { status: 202, body: { id: "01JDEL00000000000000000000", state: "done", delete_messages: true, messages_total: 0, messages_done: 0, created_at: "", purge_after: "", user_id: "", address: "", by_admin: false, status_token: "tok" } } });
    renderWithProviders(<DeleteAccountSection />);
    const u = userEvent.setup();
    await u.click(screen.getByTestId("delete-account-open"));
    const confirm = screen.getByTestId("delete-account-confirm");
    expect(confirm).toBeDisabled();
    await u.type(screen.getByTestId("delete-confirm"), "bob");
    expect(confirm).toBeDisabled();
    await u.clear(screen.getByTestId("delete-confirm"));
    await u.type(screen.getByTestId("delete-confirm"), "Alice");
    await u.click(screen.getByTestId("delete-messages"));
    expect(confirm).toBeEnabled();
    await u.click(confirm);
    const del = calls.find((c) => c.init.method === "DELETE" && c.url.endsWith("/api/v1/users/me"));
    expect(del).toBeDefined();
    expect(JSON.parse(del!.init.body as string)).toEqual({ confirm: "Alice", delete_messages: true });
  });
});
