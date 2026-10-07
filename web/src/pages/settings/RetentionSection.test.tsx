// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Permission, type RoomDetail } from "@tavrn/sdk";
import { RetentionSection } from "./RetentionSection";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const room = (perms: string, days: number | null) => ({ id: "r1", name: "Raum", my_permissions: perms, attachment_retention_days: days }) as unknown as RoomDetail;
const MANAGE_ROOM = String(Permission.MANAGE_ROOM);

describe("RetentionSection (design note 4.13 item 2)", () => {
  it("shows the node bound and saves a shorter period", async () => {
    useAuth.setState({ token: "acc" });
    const calls = mockFetch({
      "/users/me/entitlements": { body: { values: { "attachments.retention_days": 30 }, upload_max_bytes: 1, retention_bound_days: 30 } },
      "/rooms/r1": { body: {} },
    });
    renderWithProviders(<RetentionSection room={room(MANAGE_ROOM, null)} />);
    expect(await screen.findByText(/nach 30 Tagen; der Raum kann nur einen kürzeren/)).toBeInTheDocument();
    expect(screen.getByTestId("retention-effective")).toHaveTextContent("Anhänge werden nach 30 Tagen gelöscht.");
    const input = screen.getByTestId("retention-days");
    expect(input).toHaveAttribute("max", "30");
    const u = userEvent.setup();
    await u.clear(input);
    await u.type(input, "7");
    await u.click(screen.getByRole("button", { name: "Speichern" }));
    const patch = calls.find((c) => c.url.endsWith("/rooms/r1") && c.init.method === "PATCH");
    expect(JSON.parse(String(patch!.init.body))).toEqual({ attachment_retention_days: 7 });
  });

  it("is read-only without manage_room and says when attachments are kept", async () => {
    mockFetch({ "/users/me/entitlements": { body: { values: { "attachments.retention_days": 0 }, upload_max_bytes: 1, retention_bound_days: 0 } } });
    renderWithProviders(<RetentionSection room={room("0", null)} />);
    expect(await screen.findByText("Anhänge werden behalten.")).toBeInTheDocument();
    expect(screen.getByTestId("retention-days")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
  });
});
