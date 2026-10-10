// SPDX-License-Identifier: Apache-2.0
// File types in the override editors (tavrn-protocol permissions.md "Upload categories"): allow / neutral / deny per
// category and subject, what a neutral category inherits, the effective result, and the save payload.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { ChannelsTab } from "./ChannelsTab";
import { useAuth } from "../../stores/auth";
import { useLocale } from "../../i18n";
import { mockFetch, renderWithProviders } from "../../test/render";

const channel = (id: string, name: string, category_id: string | null) => ({ id, room_id: "r1", category_id, kind: "text", name, topic: "", position: 0, encrypted: true, slowmode_secs: 0, bitrate_kbps: 64, user_limit: 0, system_name: null, no_bots: false });
const role = (id: string, name: string, position: number, extra: object = {}) => ({ id, room_id: "r1", name, color: null, position, permissions: Permission.VIEW_CHANNEL.toString(), hoist: false, mentionable: false, is_everyone: false, ...extra });
const room = {
  id: "r1", name: "Room", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
  member_count: 2, categories: [{ id: "team", room_id: "r1", name: "Team", position: 0, no_bots: false }],
  channels: [channel("c1", "general", "team")],
  roles: [
    role("artists", "Artists", 2, { allowed_upload_categories: ["images"] }),
    role("everyone", "@everyone", 0, { is_everyone: true, allowed_upload_categories: ["images", "documents"] }),
  ],
  overrides: [
    { id: "o1", target_type: "category", target_id: "team", subject_type: "role", subject_id: "artists", allow: "0", deny: "0", upload_allow: ["video"], upload_deny: [] },
    { id: "o2", target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "artists", allow: "0", deny: "0", upload_allow: ["documents"], upload_deny: ["images"] },
  ],
  my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
} as unknown as RoomDetail;

const radio = (scope: HTMLElement, name: string) => within(scope).getByRole("radio", { name });

describe("ChannelsTab: file types in the overrides", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
  });

  it("shows allow / deny / neutral per category, the inherited values and the effective result", async () => {
    mockFetch({});
    renderWithProviders(<ChannelsTab room={room} />, { route: "/rooms/r1/settings/channels" });
    const editor = await screen.findByTestId("channel-editor");
    await userEvent.setup().selectOptions(within(editor).getByRole("combobox", { name: "Role" }), "role:artists");
    const block = within(editor).getByTestId("upload-overrides");
    expect(radio(block, "Documents: allow")).toHaveAttribute("aria-checked", "true");
    expect(radio(block, "Images: deny")).toHaveAttribute("aria-checked", "true");
    expect(radio(block, "Videos: neutral")).toHaveAttribute("aria-checked", "true");
    // Videos: allowed by the category's override; Images: the role's own list.
    expect(within(block).getByTestId("inherited-upload-video")).toHaveTextContent("Inherited: allowed by the category");
    expect(within(block).getByTestId("inherited-upload-images")).toHaveTextContent("Inherited: allowed by the roles");
    expect(within(block).getByTestId("inherited-upload-audio")).toHaveTextContent("Inherited: denied by the roles");
    expect(within(block).getByTestId("upload-effective")).toHaveTextContent("Result for Artists: Videos, Documents");
  });

  it("saves upload_allow and upload_deny with the override; the effective result follows the edits", async () => {
    const calls = mockFetch({ "/rooms/r1/overrides": { body: [] } });
    renderWithProviders(<ChannelsTab room={room} />, { route: "/rooms/r1/settings/channels" });
    const u = userEvent.setup();
    const editor = await screen.findByTestId("channel-editor");
    const block = within(editor).getByTestId("upload-overrides");
    // @everyone: nothing set here; the room default is effective.
    expect(within(block).getByTestId("upload-effective")).toHaveTextContent("Images, Documents");
    await u.click(radio(block, "Archives: allow"));
    await u.click(radio(block, "Documents: deny"));
    expect(within(block).getByTestId("upload-effective")).toHaveTextContent("Images, Archives");
    await u.click(within(editor).getByRole("button", { name: "Save permissions" }));
    const put = calls.find((c) => c.url.endsWith("/rooms/r1/overrides"));
    expect(JSON.parse(String(put!.init.body))).toMatchObject({ target_type: "channel", target_id: "c1", subject_type: "role", subject_id: "everyone", allow: "0", deny: "0", upload_allow: ["archives"], upload_deny: ["documents"] });
  });

  it("the category editor has the same block", async () => {
    const calls = mockFetch({ "/rooms/r1/overrides": { body: [] } });
    renderWithProviders(<ChannelsTab room={room} />, { route: "/rooms/r1/settings/channels?category=team" });
    const u = userEvent.setup();
    const editor = await screen.findByTestId("category-editor");
    await u.selectOptions(within(editor).getByRole("combobox", { name: "Role" }), "role:artists");
    const block = within(editor).getByTestId("upload-overrides");
    expect(radio(block, "Videos: allow")).toHaveAttribute("aria-checked", "true");
    await u.click(radio(block, "Videos: neutral"));
    await u.click(within(editor).getByRole("button", { name: "Save permissions" }));
    const put = calls.find((c) => c.url.endsWith("/rooms/r1/overrides"));
    expect(JSON.parse(String(put!.init.body))).toMatchObject({ target_type: "category", target_id: "team", subject_id: "artists", upload_allow: [], upload_deny: [] });
  });
});
