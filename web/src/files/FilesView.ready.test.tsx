// SPDX-License-Identifier: Apache-2.0
/**
 * An encrypted files channel takes uploads only once its group is ready on this device (FILES.md §8): a file chosen
 * before was refused with a passing toast and lost (tavrn-web#169), so the upload is not offered until then.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import FilesView from "./FilesView";

const state = vi.hoisted(() => ({ e2ee: { phase: "joining", mls: null as unknown, waiting: [] as string[], ghosts: [] as unknown[], error: null, rejoined: false, tick: 0 } }));
vi.mock("../hooks/useE2eeConversation", () => ({ useE2eeConversation: () => state.e2ee, useDecrypted: () => ({}), usePlainSignatures: () => ({}) }));

const me = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };
const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "files", name: "docs", encrypted: true, history_for_new_members: "since_join" } as unknown as Channel;
const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", channels: [channel] } as unknown as RoomDetail;

function setup() {
  useAuth.setState({ token: "t", user: me as never });
  mockFetch({
    "/files/usage": { body: { used_bytes: 0, max_bytes: 1000000, can_upload: true, can_manage: false, encrypted: true } },
    "/files": { body: { entries: [], path: [], next_after: null } },
    "/members": { body: [] },
  });
  renderWithProviders(<FilesView room={room} channel={channel} />);
}

describe("uploads into an encrypted files channel", () => {
  it("are not offered while the channel's encryption is still being set up on this device", async () => {
    state.e2ee = { ...state.e2ee, phase: "joining", mls: null };
    setup();
    const button = await screen.findByTestId("files-upload-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Die Verschlüsselung dieses Channels ist auf diesem Gerät noch nicht bereit.");
    expect(screen.queryByTestId("files-upload-input")).toBeNull();
  });

  it("are offered once the group is ready", async () => {
    state.e2ee = { ...state.e2ee, phase: "ready", mls: { encrypt: vi.fn(), decrypt: vi.fn() } };
    setup();
    expect(await screen.findByTestId("files-upload-button")).toBeEnabled();
    expect(screen.getByTestId("files-upload-input")).toBeInTheDocument();
  });
});
