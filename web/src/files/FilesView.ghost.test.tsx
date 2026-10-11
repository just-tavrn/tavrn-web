// SPDX-License-Identifier: Apache-2.0
/** The ghost gate of an encrypted files channel (ENCRYPTION.md §4.6): no record is encrypted until acknowledged. */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import type { GhostViolation } from "@tavrn/e2ee";
import { useAuth } from "../stores/auth";
import { useMlsUi } from "../stores/mls";
import { useToasts } from "../stores/toasts";
import { mockFetch, renderWithProviders } from "../test/render";
import FilesView from "./FilesView";

const ghost: GhostViolation = { identity: "bob@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD1", reason: "unattested", key: "a2V5" };
const acknowledgeGhosts = vi.fn(async () => undefined);
const encrypt = vi.fn(async () => ({ content: "x", epoch: 1 }));
const e2ee = { phase: "ready", mls: { acknowledgeGhosts, encrypt, decrypt: vi.fn() }, waiting: [] as string[], ghosts: [ghost], error: null, rejoined: false, tick: 0 };
vi.mock("../hooks/useE2eeConversation", () => ({ useE2eeConversation: () => e2ee, useDecrypted: () => ({}), usePlainSignatures: () => ({}) }));

const me = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

describe("encrypted files channel with an unknown device", () => {
  it("shows the warning and uploads nothing until the user acknowledged it", async () => {
    useAuth.setState({ token: "t", user: me as never });
    useMlsUi.setState({ ghostAck: {} });
    useToasts.setState({ toasts: [] });
    const calls = mockFetch({
      "/files/usage": { body: { used_bytes: 0, max_bytes: 1000000, can_upload: true, can_manage: false, encrypted: true } },
      "/files": { body: { entries: [], path: [], next_after: null } },
      "/members": { body: { items: [], next: null } },
    });
    const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "files", name: "docs", encrypted: true, history_for_new_members: "since_join" } as unknown as Channel;
    const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", channels: [channel] } as unknown as RoomDetail;
    renderWithProviders(<FilesView room={room} channel={channel} />);
    expect(await screen.findByTestId("ghost-warning")).toHaveTextContent(ghost.identity);
    const input = await screen.findByTestId("files-upload-input");
    fireEvent.change(input, { target: { files: [new File(["geheim"], "plan.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(JSON.stringify(useToasts.getState().toasts)).toContain("Bestätige zuerst die Warnung zum unbekannten Gerät."));
    expect(encrypt).not.toHaveBeenCalled();
    expect(calls.some((c) => (c.init.method ?? "GET") !== "GET")).toBe(false);
    await userEvent.setup().click(screen.getByRole("button", { name: "Ich verstehe" }));
    await waitFor(() => expect(acknowledgeGhosts).toHaveBeenCalledWith("t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VF0", [{ identity: ghost.identity, key: ghost.key }]));
  });
});
