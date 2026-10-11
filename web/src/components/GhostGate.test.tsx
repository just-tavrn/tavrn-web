// SPDX-License-Identifier: Apache-2.0
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Permission, type Channel, type RoomDetail } from "@tavrn/sdk";
import type { GhostViolation, MlsManager } from "@tavrn/e2ee";
import { useAuth } from "../stores/auth";
import { useMlsUi } from "../stores/mls";
import { mockFetch, renderWithProviders } from "../test/render";
import { forgetGhostAck, isGhostRefusal, useGhostGate } from "./GhostGate";
import { ForumView } from "../threads/ForumView";

const ghost: GhostViolation = { identity: "bob@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD1", reason: "unattested" };
const acknowledge = vi.fn(async () => undefined);
const mls = { acknowledgeGhosts: acknowledge } as unknown as MlsManager;
let e2ee = { phase: "ready", mls, waiting: [] as string[], ghosts: [ghost] as GhostViolation[], error: null, rejoined: false, tick: 0 };

vi.mock("../hooks/useE2eeConversation", () => ({
  useE2eeConversation: () => e2ee,
  useDecrypted: () => ({}),
  usePlainSignatures: () => ({}),
}));
vi.mock("../hooks/useChannelHistory", () => ({ useChannelHistory: () => ({ locked: false }) }));

describe("the ghost gate of encrypted write paths (ENCRYPTION.md §4.6)", () => {
  it("blocks until the user acknowledged, tells the session manager, and blocks again for a new ghost or a refusal", async () => {
    const q = "t.local/01J9ZK3G5M8Q2W4E6R8T0Y2V00";
    const { result, rerender } = renderHook(({ ghosts }) => useGhostGate(q, { ghosts, mls }, true), { initialProps: { ghosts: [ghost] } });
    expect(result.current.blocked).toBe(true);
    await act(() => result.current.acknowledge());
    expect(acknowledge).toHaveBeenCalledWith(q, [ghost.identity]);
    expect(result.current.blocked).toBe(false);
    rerender({ ghosts: [ghost, { identity: "eve@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VE1", reason: "not_member" }] });
    expect(result.current.blocked).toBe(true);
    act(() => forgetGhostAck(q));
    rerender({ ghosts: [ghost] });
    expect(result.current.blocked).toBe(true);
    // Outside encrypted conversations there is nothing to gate.
    const plain = renderHook(() => useGhostGate(q, { ghosts: [ghost], mls }, false));
    expect(plain.result.current.blocked).toBe(false);
    expect(isGhostRefusal(Object.assign(new Error("ghost"), { name: "MlsError", code: "ghost" }))).toBe(true);
    expect(isGhostRefusal(new Error("ghost"))).toBe(false);
  });

  it("forum: no new post while a ghost is not acknowledged", async () => {
    useAuth.setState({ token: "t", user: { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true } });
    useMlsUi.setState({ ghostAck: {} });
    e2ee = { ...e2ee, ghosts: [ghost] };
    mockFetch({ "/threads": { body: { items: [], next: null } } });
    const channel = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VF0", kind: "forum", name: "ideas", encrypted: true, tags: [], history_for_new_members: "since_join" } as unknown as Channel;
    const room = { id: "01J9ZK3G5M8Q2W4E6R8T0Y2VR0", channels: [channel] } as unknown as RoomDetail;
    renderWithProviders(<ForumView room={room} channel={channel} perms={Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL} members={["alice@t.local", "bob@t.local"]} mayManage={false} domain="t.local" onOpen={() => undefined} />);
    expect(screen.getByTestId("ghost-warning")).toHaveTextContent(ghost.identity);
    expect(screen.getByTestId("forum-new-post")).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Ich verstehe" }));
    await waitFor(() => expect(screen.getByTestId("forum-new-post")).toBeEnabled());
    expect(acknowledge).toHaveBeenCalledWith("t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VF0", [ghost.identity]);
  });
});
