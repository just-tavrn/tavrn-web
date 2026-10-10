// SPDX-License-Identifier: Apache-2.0
// "Allowed file types" per role (tavrn-protocol permissions.md "Upload categories"): not set (inherit) or a list,
// saved with the role; @everyone is the room default and links to the room overview.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { RolesTab } from "./RolesTab";
import { useAuth } from "../../stores/auth";
import { useLocale } from "../../i18n";
import { mockFetch, renderWithProviders } from "../../test/render";

const role = (id: string, name: string, position: number, extra: object = {}) => ({ id, room_id: "r1", name, color: null, position, permissions: Permission.VIEW_CHANNEL.toString(), hoist: false, mentionable: false, is_everyone: false, ...extra });
const room = {
  id: "r1", name: "Room", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2, categories: [], channels: [],
  roles: [
    role("artists", "Artists", 2, { allowed_upload_categories: ["images"] }),
    role("guests", "Guests", 1, { allowed_upload_categories: null }),
    role("everyone", "@everyone", 0, { is_everyone: true, allowed_upload_categories: ["images", "documents"] }),
  ],
  overrides: [], my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
} as unknown as RoomDetail;

const bodyOf = (calls: { url: string; init: RequestInit }[], roleId: string) => {
  const put = calls.find((c) => c.url.endsWith(`/rooms/r1/roles/${roleId}`) && c.init.method === "PATCH");
  return put ? JSON.parse(String(put.init.body)) : undefined;
};

describe("RolesTab: allowed file types", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
  });

  it("a role with a list: change a category and save it with the role", async () => {
    const calls = mockFetch({ "/rooms/r1/roles/artists": { body: {} } });
    renderWithProviders(<RolesTab room={room} />, { route: "/rooms/r1/settings/roles" });
    const section = await screen.findByTestId("role-uploads");
    expect(within(section).getByRole("checkbox", { name: /Not set/ })).not.toBeChecked();
    expect(within(section).getByRole("checkbox", { name: "Images" })).toBeChecked();
    expect(within(section).getByRole("checkbox", { name: "Documents" })).not.toBeChecked();
    const u = userEvent.setup();
    await u.click(within(section).getByRole("checkbox", { name: "Videos" }));
    await u.click(screen.getByRole("button", { name: "Save" }));
    expect(bodyOf(calls, "artists")).toMatchObject({ allowed_upload_categories: ["images", "video"] });
  });

  it("\"not set\" saves null; setting a list starts from the room default", async () => {
    const calls = mockFetch({ "/rooms/r1/roles/": { body: {} } });
    renderWithProviders(<RolesTab room={room} />, { route: "/rooms/r1/settings/roles" });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Artists" }));
    await u.click(within(screen.getByTestId("role-uploads")).getByRole("checkbox", { name: /Not set/ }));
    expect(within(screen.getByTestId("role-uploads")).getByRole("checkbox", { name: "Images" })).toBeDisabled();
    await u.click(screen.getByRole("button", { name: "Save" }));
    expect(bodyOf(calls, "artists")).toMatchObject({ allowed_upload_categories: null });

    await u.click(screen.getByRole("button", { name: "Guests" }));
    const guests = screen.getByTestId("role-uploads");
    const notSet = within(guests).getByRole("checkbox", { name: /Not set/ });
    expect(notSet).toBeChecked();
    // Shows what the role inherits (here: the room default) without being editable.
    expect(within(guests).getByRole("checkbox", { name: "Documents" })).toBeChecked();
    expect(within(guests).getByRole("checkbox", { name: "Documents" })).toBeDisabled();
    await u.click(notSet);
    await u.click(within(guests).getByRole("checkbox", { name: "Documents" }));
    await u.click(screen.getByRole("button", { name: "Save" }));
    expect(bodyOf(calls, "guests")).toMatchObject({ allowed_upload_categories: ["images"] });
  });

  it("an unchanged setting is not sent (the room overview may have changed it meanwhile)", async () => {
    const calls = mockFetch({ "/rooms/r1/roles/artists": { body: {} } });
    renderWithProviders(<RolesTab room={room} />, { route: "/rooms/r1/settings/roles" });
    await screen.findByTestId("role-uploads");
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(bodyOf(calls, "artists")).not.toHaveProperty("allowed_upload_categories");
  });

  it("@everyone is the room default: no \"not set\", a link to the room overview", async () => {
    mockFetch({});
    renderWithProviders(<RolesTab room={room} />, { route: "/rooms/r1/settings/roles?role=everyone" });
    const section = await screen.findByTestId("role-uploads");
    expect(within(section).queryByRole("checkbox", { name: /Not set/ })).toBeNull();
    expect(within(section).getByRole("checkbox", { name: "Documents" })).toBeChecked();
    expect(within(section).getByRole("link", { name: /room overview/ })).toHaveAttribute("href", "/rooms/r1/settings/overview");
  });
});
