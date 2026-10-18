// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router";
import { renderWithProviders } from "../../test/render";
import { useAuth } from "../../stores/auth";
import { RoomSettingsPage } from "./RoomSettingsPage";
import { useVoiceSettings, DEFAULT_SETTINGS } from "../../voice/settings";
vi.mock("../ChannelSidebar", () => ({ useRoom: () => ({ data: { id: "selected", name: "Selected", my_permissions: "0", roles: [], channels: [] }, isPending: false, isError: false }) }));
vi.mock("../ChannelPage", () => ({ useRoomMembers: () => ({ data: [], isPending: false, isError: false }) }));
vi.mock("../../moderation/hooks", () => ({ useCapabilities: () => [], useOpenRoomReports: () => 0, badgeText: () => null }));
vi.mock("../../history/restore", () => ({ RESTORE_CAPABILITY: "restore", useRestoreRequests: () => ({ data: null }) }));

it("opens the personal whisper category without manage-room or a voice connection", async () => {
  useAuth.setState({ user: { id: "me", address: "me@n", domain: "n" } as never });
  useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
  renderWithProviders(<Routes><Route path="/rooms/:roomId/settings/:tab" element={<RoomSettingsPage />} /></Routes>, { route: "/rooms/selected/settings/whisper" });
  expect(screen.getByRole("link", { name: "Flüstern" })).toHaveAttribute("href", "/rooms/selected/settings/whisper");
  expect(screen.getByRole("heading", { name: "Flüstern" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Rollen" })).toBeNull();
  await userEvent.type(screen.getByRole("textbox", { name: "Gruppenname" }), "Personal");
  await userEvent.click(screen.getByRole("button", { name: "Neue Flüstergruppe" }));
  expect(useVoiceSettings.getState().settings.whisperGroups["n/selected"]?.[0]?.name).toBe("Personal");
});
