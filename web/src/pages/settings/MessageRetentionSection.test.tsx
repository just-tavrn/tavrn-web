// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Permission, type RoomDetail } from "@tavrn/sdk";
import { MessageRetentionSection } from "./MessageRetentionSection";
import { useAuth } from "../../stores/auth";
import { useLocale } from "../../i18n";
import { mockFetch, renderWithProviders } from "../../test/render";

const room = (perms: string, days: number | null) => ({ id: "r1", name: "Raum", my_permissions: perms, message_retention_days: days }) as unknown as RoomDetail;
const MANAGE_ROOM = String(Permission.MANAGE_ROOM);

beforeEach(() => useLocale.setState({ locale: "de" }));

describe("MessageRetentionSection (PROTOCOL.md §7f)", () => {
  it("shows the node's value and saves a shorter period", async () => {
    useAuth.setState({ token: "acc" });
    const calls = mockFetch({ "/api/v1/node": { body: { message_retention_days: 30 } }, "/rooms/r1": { body: {} } });
    renderWithProviders(<MessageRetentionSection room={room(MANAGE_ROOM, null)} />);
    expect(await screen.findByText(/löscht Nachrichten nach 30 Tagen; der Raum kann nur einen kürzeren/)).toBeInTheDocument();
    expect(screen.getByTestId("message-retention-effective")).toHaveTextContent("Nachrichten werden nach 30 Tagen gelöscht");
    const input = screen.getByTestId("message-retention-days");
    expect(input).toHaveAttribute("max", "30");
    const u = userEvent.setup();
    await u.clear(input);
    await u.type(input, "7");
    await u.click(screen.getByRole("button", { name: "Speichern" }));
    const patch = calls.find((c) => c.url.endsWith("/rooms/r1") && c.init.method === "PATCH");
    expect(JSON.parse(String(patch!.init.body))).toEqual({ message_retention_days: 7 });
  });

  it("is read-only without manage_room and says when messages are kept", async () => {
    mockFetch({ "/api/v1/node": { body: { message_retention_days: 0 } } });
    renderWithProviders(<MessageRetentionSection room={room("0", 14)} />);
    expect(await screen.findByText(/Dieser Knoten behält Nachrichten/)).toBeInTheDocument();
    expect(screen.getByTestId("message-retention-effective")).toHaveTextContent("Nachrichten werden nach 14 Tagen gelöscht");
    expect(screen.getByTestId("message-retention-days")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
  });
});
