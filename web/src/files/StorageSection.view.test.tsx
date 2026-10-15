// SPDX-License-Identifier: Apache-2.0
/**
 * The storage settings of a files channel offer the node's own storage ("Dieser Knoten") only where the room may use
 * it: `internal_allowed` of the files usage (the room's `files_channels.internal`, FILES.md §5); older nodes without
 * the field fall back to `internal_allowed` of `GET backend`, which is their node default.
 */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { StorageSection, internalAllowed } from "./StorageSection";

const me = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "files", name: "docs", encrypted: false, category_id: null } as unknown as Channel;
const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", is_owner: true, owner_id: "u1", roles: [], my_roles: [], overrides: [], channels: [channel] } as unknown as RoomDetail;
const backend = { url: "", username: "", password_set: false, access_key: "", secret_key_set: false, region: "", bucket: "", prefix: "", encrypt_files: false, max_bytes: 0, external_allowed: true, private_allowed: false, has_files: false, updated_at: null };
const usage = { enabled: true, used_bytes: 0, limit_bytes: 0, files: 0, folders: 0, max_upload_bytes: 1000000, encrypt_files: false, encrypted: false, can_upload: true, can_manage: true, can_configure: true, allowed_categories: [], executables_allowed: false };

function render(b: Record<string, unknown>, u: Record<string, unknown>) {
  useAuth.setState({ token: "t", user: me as never });
  mockFetch({
    "/files/backend": { body: { ...backend, ...b } },
    "/files/usage": { body: { ...usage, ...u } },
  });
  renderWithProviders(<StorageSection room={room} channel={channel} />);
}

const kinds = async () => {
  const select = await screen.findByTestId("files-storage-kind");
  return { select, values: within(select).getAllByRole("option").map((o) => (o as HTMLOptionElement).value) };
};

describe("storage settings and the room's files_channels.internal", () => {
  it("offers this node where the room may use it, even on a node whose default is off", async () => {
    render({ kind: "internal", internal_allowed: true }, { backend: "internal", internal_allowed: true });
    const { select, values } = await kinds();
    expect(values).toEqual(["internal", "webdav", "s3"]);
    expect(select).toHaveValue("internal");
    expect(screen.queryByText("Dieser Knoten speichert keine Dateien der Dateichannels dieses Raums: Wähle einen WebDAV- oder S3-Speicher.")).toBeNull();
  });

  it("does not offer this node where the room may not use it and says why", async () => {
    render({ kind: "none", internal_allowed: false }, { backend: "none", internal_allowed: false, can_upload: false });
    const { select, values } = await kinds();
    expect(values).toEqual(["webdav", "s3"]);
    expect(select).toHaveValue("webdav");
    expect(select).toHaveAccessibleDescription("Dieser Knoten speichert keine Dateien der Dateichannels dieses Raums: Wähle einen WebDAV- oder S3-Speicher.");
  });

  it("follows the usage's value of the room", async () => {
    render({ kind: "none", internal_allowed: true }, { backend: "none", internal_allowed: false });
    expect((await kinds()).values).toEqual(["webdav", "s3"]);
  });

  it("falls back to GET backend on older nodes without the usage field", async () => {
    // An older node's usage: every field but internal_allowed.
    const old = { ...usage } as { internal_allowed?: boolean };
    expect(internalAllowed(old, { internal_allowed: false })).toBe(false);
    expect(internalAllowed(old, { internal_allowed: true })).toBe(true);
    expect(internalAllowed(undefined, { internal_allowed: true })).toBe(true);
    expect(internalAllowed({ internal_allowed: false }, { internal_allowed: true })).toBe(false);
    render({ kind: "internal", internal_allowed: true }, {});
    expect((await kinds()).values).toEqual(["internal", "webdav", "s3"]);
  });
});
