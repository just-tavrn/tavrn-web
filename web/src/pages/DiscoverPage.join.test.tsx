// SPDX-License-Identifier: Apache-2.0
// Discover's join (tavrn-web#195): the room preview of the hosting node first; rules → the dialog with the checkbox,
// a privacy notice only → the link without a checkbox, nothing → the direct join.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VerifiedRoom } from "@tavrn/sdk";
import { renderWithProviders } from "../test/render";
import { useAuth } from "../stores/auth";

const discover = vi.hoisted(() => ({
  loadRooms: vi.fn(),
  loadNodes: vi.fn(),
  loadRoomIcons: vi.fn(async () => ({})),
  iconClient: vi.fn(() => null),
  joinRoom: vi.fn(async () => "/n/b.test/rooms/01ROOM"),
  previewRoom: vi.fn(),
}));
vi.mock("../stores/discover", () => discover);

import { DiscoverPage } from "./DiscoverPage";

const room = { node: "b.test", room_id: "01ROOM", name: "Lounge", description: "", member_count: 3, verification: "verified" } as unknown as VerifiedRoom;
const preview = (d: { rules?: string; privacy_notice?: string }) => ({ room: { id: "01ROOM", name: "Lounge", description: "", icon_animated: false, member_count: 3, age_gate: "none" }, rules: d.rules ?? "", privacy_notice: d.privacy_notice ?? "", privacy_notice_updated_at: null, legal_notice: "", legal_notice_updated_at: null });

describe("joining from Discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuth.setState({ token: "t", user: { id: "u1", username: "alice", domain: "a.test" } as never });
    discover.loadRooms.mockResolvedValue({ rooms: [room], next: null, hidden: 0 });
  });

  const join = async () => within(await screen.findByTestId("discover-room")).getByRole("button", { name: "Beitreten: Lounge (b.test)" });

  it("with rules: the dialog; joinRoom gets the ticked checkbox", async () => {
    const user = userEvent.setup();
    discover.previewRoom.mockResolvedValue(preview({ rules: "Be kind." }));
    renderWithProviders(<DiscoverPage />);
    await user.click(await join());
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    expect(discover.previewRoom).toHaveBeenCalledWith(room);
    expect(discover.joinRoom).not.toHaveBeenCalled();
    expect(within(dialog).getByText("b.test", { exact: false })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Ich akzeptiere die Regeln" }));
    await user.click(within(dialog).getByRole("button", { name: "Beitreten" }));
    expect(discover.joinRoom).toHaveBeenCalledWith(room, true);
  });

  it("with a privacy notice only: the link, no checkbox, joinRoom without accepting rules", async () => {
    const user = userEvent.setup();
    discover.previewRoom.mockResolvedValue(preview({ privacy_notice: "Privacy" }));
    renderWithProviders(<DiscoverPage />);
    await user.click(await join());
    const dialog = await screen.findByRole("dialog", { name: "Lounge beitreten" });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Datenschutzhinweise/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Beitreten" }));
    expect(discover.joinRoom).toHaveBeenCalledWith(room, false);
  });

  it("with nothing to show: joins directly", async () => {
    const user = userEvent.setup();
    discover.previewRoom.mockResolvedValue(preview({}));
    renderWithProviders(<DiscoverPage />);
    await user.click(await join());
    expect(discover.joinRoom).toHaveBeenCalledWith(room, false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
