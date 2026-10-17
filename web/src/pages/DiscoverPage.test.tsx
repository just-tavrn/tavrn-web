// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VerifiedRoom } from "@tavrn/sdk";
import { renderWithProviders } from "../test/render";
import { useAuth } from "../stores/auth";

const discover = vi.hoisted(() => ({
  loadRooms: vi.fn(),
  loadNodes: vi.fn(),
  loadRoomIcons: vi.fn(async () => ({})),
  iconClient: vi.fn(() => null),
  joinRoom: vi.fn(),
  previewRoom: vi.fn(),
}));
vi.mock("../stores/discover", () => discover);

import { DiscoverPage } from "./DiscoverPage";

const room = {
  node: "b.test",
  room_id: "01ROOM",
  name: "Gemeldet",
  description: "",
  member_count: 3,
  verification: "verified",
} as unknown as VerifiedRoom;

describe("DiscoverPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.setState({ token: "t", user: { id: "u1", username: "alice", domain: "a.test" } as never });
  });

  it("a report dialog stays open while the list behind it loads again (the search changed)", async () => {
    const user = userEvent.setup();
    // The unfiltered list shows the room at once; the search for it is still loading when the dialog is open.
    discover.loadRooms.mockImplementation(async (filter: { q?: string }) => (filter.q ? new Promise(() => {}) : { rooms: [room], next: null, hidden: 0 }));
    renderWithProviders(<DiscoverPage />);
    const card = await screen.findByTestId("discover-room");
    await user.type(screen.getByTestId("discover-search"), "Gem");
    await user.click(within(card).getByRole("button", { name: "Melden: Gemeldet (b.test)" }));
    expect(screen.getByTestId("report-dialog")).toBeInTheDocument();
    // The debounced search starts a new query: its list is empty while it loads, the card is gone.
    await waitFor(() => expect(discover.loadRooms).toHaveBeenCalledWith(expect.objectContaining({ q: "Gem" })));
    await waitFor(() => expect(screen.queryByTestId("discover-room")).toBeNull());
    expect(screen.getByTestId("report-dialog")).toHaveTextContent("nicht an b.test");
  });
});
