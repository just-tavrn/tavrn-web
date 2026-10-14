// SPDX-License-Identifier: Apache-2.0
// The entry point of the role preview: only for @everyone and the roles the viewer may manage; the dialog combines
// roles and sets the join date, then the room opens as them.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import type { Role, RoomDetail } from "@tavrn/sdk";
import { ViewAsRole, localDateTimeValue, previewableRoles } from "./ViewAsRole";
import { useRolePreview } from "../../stores/rolePreview";
import { useAuth } from "../../stores/auth";

const role = (id: string, position: number, is_everyone = false) => ({ id, room_id: "r1", name: is_everyone ? "@everyone" : id, color: null, position, permissions: "0", hoist: false, mentionable: false, is_everyone }) as Role;
const roles = [role("everyone", 0, true), role("helpers", 1), role("mods", 2), role("leads", 3)];
const room = (my_roles: string[], is_owner = false) => ({ id: "r1", roles, my_roles, is_owner, channels: [], categories: [], overrides: [] }) as unknown as RoomDetail;

beforeEach(() => {
  useRolePreview.getState().exit();
  useAuth.setState({ token: "t", user: { address: "me@localhost", username: "me", domain: "localhost" } as never });
});

describe("ViewAsRole", () => {
  it("offers the roles below the viewer's highest one (all of them to the owner)", () => {
    expect(previewableRoles(room(["mods"])).map((r) => r.id)).toEqual(["helpers"]);
    expect(previewableRoles(room([], true)).map((r) => r.id)).toEqual(["leads", "mods", "helpers"]);
    expect(localDateTimeValue(new Date(2026, 9, 4, 7, 5).getTime())).toBe("2026-10-04T07:05");
  });

  it("is not offered for a role at or above the viewer's own", () => {
    render(
      <MemoryRouter>
        <ViewAsRole room={room(["mods"])} role={roles[2]!} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("view-as-role")).toBeNull();
  });

  it("starts the preview with the chosen roles and join date and opens the room", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/rooms/r1/settings/roles"]}>
        <Routes>
          <Route path="/rooms/r1/settings/roles" element={<ViewAsRole room={room([], true)} role={roles[1]!} />} />
          <Route path="/rooms/r1" element={<p>room</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByTestId("view-as-role"));
    const dialog = screen.getByRole("dialog", { name: "Raum als Rolle ansehen" });
    expect(dialog).toBeVisible();
    const options = screen.getAllByTestId("view-as-role-option");
    expect(options.map((o) => (o as HTMLInputElement).checked)).toEqual([false, false, true]);
    await user.click(options[1]!);
    await user.clear(screen.getByLabelText("Beitrittsdatum"));
    await user.type(screen.getByLabelText("Beitrittsdatum"), "2026-10-01T09:30");
    await user.click(screen.getByRole("button", { name: "Vorschau starten" }));
    const preview = useRolePreview.getState().preview!;
    expect(preview.roomId).toBe("r1");
    expect(preview.roleIds).toEqual(["mods", "helpers"]);
    expect(preview.label).toBe("mods, helpers");
    expect(preview.joinedAt).toBe(new Date(2026, 9, 1, 9, 30).getTime());
    expect(await screen.findByText("room")).toBeVisible();
  });
});
