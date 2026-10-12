// SPDX-License-Identifier: Apache-2.0
/**
 * A files channel without a store (FILES.md §5, `TAVRN_FILES_INTERNAL=off`): `backend: "none"` shows "choose a store
 * first" instead of the upload button until the channel's managers set an external store.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import FilesView from "./FilesView";

const me = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "files", name: "docs", encrypted: false } as unknown as Channel;
const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", channels: [channel] } as unknown as RoomDetail;
const usage = { enabled: true, used_bytes: 0, limit_bytes: 0, files: 0, folders: 0, max_upload_bytes: 1000000, encrypt_files: false, encrypted: false, can_manage: true, allowed_categories: [], executables_allowed: false };

function render(info: Record<string, unknown>) {
  useAuth.setState({ token: "t", user: me as never });
  mockFetch({
    "/files/usage": { body: { ...usage, ...info } },
    "/files": { body: { entries: [], path: [], next_after: null } },
    "/members": { body: { items: [], next: null } },
  });
  renderWithProviders(<FilesView room={room} channel={channel} />);
}

describe("files channel without a store", () => {
  it("offers the channel's storage settings instead of the upload button to members who may configure it", async () => {
    render({ backend: "none", can_upload: false, can_configure: true });
    const link = await screen.findByRole("link", { name: "Zuerst einen Speicher wählen" });
    expect(link.getAttribute("href")).toMatch(new RegExp(`/rooms/${room.id}/settings/channels\\?channel=${channel.id}$`));
    expect(screen.queryByTestId("files-upload-button")).toBeNull();
    expect(screen.queryByTestId("files-new-folder")).toBeNull();
    expect(screen.queryByTestId("files-banner-external")).toBeNull();
    expect(await screen.findByTestId("files-empty")).toHaveTextContent("Dieser Knoten speichert selbst keine Dateien von Dateichannels");
  });

  it("explains it to members who cannot configure the store", async () => {
    render({ backend: "none", can_upload: false, can_configure: false });
    expect(await screen.findByTestId("files-choose-store")).toHaveTextContent("Zuerst einen Speicher wählen");
    expect(screen.queryByRole("link", { name: "Zuerst einen Speicher wählen" })).toBeNull();
    expect(screen.queryByTestId("files-upload-button")).toBeNull();
  });

  it("shows the upload button once an external store is set", async () => {
    render({ backend: "webdav", can_upload: true, can_configure: true });
    expect(await screen.findByTestId("files-upload-button")).toBeInTheDocument();
    expect(screen.queryByTestId("files-choose-store")).toBeNull();
    expect(screen.getByTestId("files-banner-external")).toHaveTextContent("WebDAV");
  });
});
