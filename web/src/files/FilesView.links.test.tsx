// SPDX-License-Identifier: Apache-2.0
/**
 * File links (PROTOCOL.md §7h): `…/channels/<channel>/files/<id>` opens the files channel at the file (its folder,
 * the file selected; a folder link opens the folder), a refused or missing file opens the channel with a notice;
 * "Copy link" in an entry's menu copies the canonical link on the hosting node.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { useLocale } from "../i18n";
import { useToasts } from "../stores/toasts";
import { mockFetch, renderWithProviders } from "../test/render";
import FilesView from "./FilesView";

const me = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "files", name: "docs", encrypted: false } as unknown as Channel;
const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", channels: [channel] } as unknown as RoomDetail;
const usage = { enabled: true, used_bytes: 0, limit_bytes: 0, files: 1, folders: 1, max_upload_bytes: 1000000, encrypt_files: false, encrypted: false, can_upload: true, can_manage: true, allowed_categories: [], executables_allowed: false, backend: "internal" };
const FOLDER = "01J9ZK3G5M8Q2W4E6R8T0Y2VA0";
const FILE = "01J9ZK3G5M8Q2W4E6R8T0Y2VB0";
const entry = (id: string, kind: "file" | "folder", parent: string | null, name: string) => ({ id, channel_id: channel.id, parent_id: parent, kind, name, mime: kind === "file" ? "text/plain" : "", size: 12, created_by: "u1", created_at: "", updated_at: "" });
const base = `/rooms/${room.id}/channels/${channel.id}`;

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function show(route: string, single: { status?: number; body: unknown }) {
  useAuth.setState({ token: "t", user: me as never });
  mockFetch({
    [`/files/${FILE}`]: single,
    [`/files/${FOLDER}`]: { body: { entry: entry(FOLDER, "folder", null, "raids"), path: [] } },
    "/files/usage": { body: usage },
    "/files": { body: { entries: [entry(FILE, "file", FOLDER, "roster.txt")], path: [{ id: FOLDER, name: "raids" }], next_after: null } },
    "/members": { body: [] },
  });
  renderWithProviders(
    <>
      <Routes>
        <Route path="/rooms/:roomId/channels/:channelId" element={<FilesView room={room} channel={channel} />}>
          <Route path="files/:fileId" element={null} />
        </Route>
      </Routes>
      <Where />
    </>,
    { route },
  );
}

beforeEach(() => {
  useLocale.setState({ locale: "en" });
  useToasts.setState({ toasts: [] } as never);
});

describe("file links", () => {
  it("open the file's folder with the file selected", async () => {
    show(`${base}/files/${FILE}`, { body: { entry: entry(FILE, "file", FOLDER, "roster.txt"), path: [{ id: FOLDER, name: "raids" }] } });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`${base}?folder=${FOLDER}`));
    const row = await screen.findByRole("option", { name: /roster\.txt/ });
    await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
  });

  it("a folder link opens the folder", async () => {
    show(`${base}/files/${FOLDER}`, { body: {} });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`${base}?folder=${FOLDER}`));
    expect(screen.getByTestId("where").textContent).not.toContain("entry=");
  });

  it("a file the node refuses opens the channel with a notice, nothing else", async () => {
    show(`${base}/files/${FILE}`, { status: 403, body: { code: "channel.view_forbidden", status: 403, title: "Forbidden", detail: "", type: "x" } });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(new RegExp(`^${base}$`)));
    expect(useToasts.getState().toasts.map((t) => t.title)).toContain("File not available");
  });

  it("Copy link in the entry's menu copies the canonical link", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show(base, { body: {} });
    const row = await screen.findByRole("option", { name: /roster\.txt/ });
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(copied).toMatch(new RegExp(`/rooms/${room.id}/channels/${channel.id}/files/${FILE}$`));
    expect(copied).toMatch(/^https?:\/\//);
  });
});
