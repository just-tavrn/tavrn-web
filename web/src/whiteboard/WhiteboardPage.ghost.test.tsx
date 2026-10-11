// SPDX-License-Identifier: Apache-2.0
/** The ghost gate of a channel's whiteboard (ENCRYPTION.md §4.6): no scene is encrypted until acknowledged. */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GhostViolation } from "@tavrn/e2ee";
import { useAuth } from "../stores/auth";
import { useMlsUi } from "../stores/mls";
import { mockFetch, renderWithProviders } from "../test/render";
import { useChannelBoard } from "./WhiteboardPage";

const ghost: GhostViolation = { identity: "bob@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD1", reason: "not_member", key: "a2V5" };
const acknowledgeGhosts = vi.fn(async () => undefined);
const e2ee = { phase: "ready", mls: { acknowledgeGhosts }, waiting: [] as string[], ghosts: [ghost], error: null, rejoined: false, tick: 0 };
vi.mock("../hooks/useE2eeConversation", () => ({ useE2eeConversation: () => e2ee, useDecrypted: () => ({}), usePlainSignatures: () => ({}) }));

const ROOM = "01J9ZK3G5M8Q2W4E6R8T0Y2VR0";
const CHANNEL = "01J9ZK3G5M8Q2W4E6R8T0Y2VF0";
const me = { id: "u1", username: "alice", domain: "t.local", address: "alice@t.local", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

function Board() {
  const board = useChannelBoard(ROOM, CHANNEL);
  if (!board.props) return <p>loading</p>;
  return (
    <div>
      <p data-testid="board-ready">{String(board.props.ready)}</p>
      {!board.props.ready && board.props.notReady}
    </div>
  );
}

describe("encrypted whiteboard with an unknown device", () => {
  it("is not ready (no scene goes out) and shows the warning until the user acknowledged it", async () => {
    useAuth.setState({ token: "t", user: me as never });
    useMlsUi.setState({ ghostAck: {} });
    const channel = { id: CHANNEL, kind: "text", name: "general", encrypted: true, position: 0, overrides: [] };
    mockFetch({
      [`/rooms/${ROOM}/members`]: { body: { items: [], next: null } },
      [`/rooms/${ROOM}`]: { body: { id: ROOM, name: "Guild", owner_id: "u1", channels: [channel], roles: [{ id: ROOM, name: "@everyone", permissions: "-1", position: 0, is_everyone: true }], my_roles: [], overrides: [], members_count: 1, read_states: [] } },
    });
    renderWithProviders(<Board />);
    await waitFor(() => expect(screen.getByTestId("board-ready")).toHaveTextContent("false"));
    expect(screen.getByTestId("ghost-warning")).toHaveTextContent(ghost.identity);
    await userEvent.setup().click(screen.getByRole("button", { name: "Ich verstehe" }));
    await waitFor(() => expect(screen.getByTestId("board-ready")).toHaveTextContent("true"));
    expect(acknowledgeGhosts).toHaveBeenCalledWith(`t.local/${CHANNEL}`, [{ identity: ghost.identity, key: ghost.key }]);
  });
});
