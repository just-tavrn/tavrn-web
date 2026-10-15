// SPDX-License-Identifier: Apache-2.0
// The role editor while another admin changes the same role (a realtime update of the room): edits in progress stay,
// a notice offers the newer version; an untouched form follows the update.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, Permission, type RoomDetail } from "@tavrn/sdk";
import { RolesTab } from "./RolesTab";
import { useAuth } from "../../stores/auth";
import { useLocale } from "../../i18n";
import { mockFetch } from "../../test/render";

const VIEW = Permission.VIEW_CHANNEL;
const SEND = Permission.SEND_MESSAGES;
const roomWith = (artists: { name?: string; permissions?: bigint; color?: string | null }) =>
  ({
    id: "r1", name: "Room", description: "", rules: "", join_mode: "invite", owner_id: "owner", icon_blob_id: null, icon_animated: false, banner_blob_id: null, created_at: "", discoverable: false, no_bots: false, bots_in_encrypted_channels: "allowed",
    member_count: 2, categories: [], channels: [],
    roles: [
      { id: "artists", room_id: "r1", name: artists.name ?? "Artists", color: artists.color ?? null, position: 1, permissions: (artists.permissions ?? VIEW).toString(), hoist: false, mentionable: false, is_everyone: false, allowed_upload_categories: null },
      { id: "everyone", room_id: "r1", name: "@everyone", color: null, position: 0, permissions: "0", hoist: false, mentionable: false, is_everyone: true, allowed_upload_categories: ["images"] },
    ],
    overrides: [], my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [],
  }) as unknown as RoomDetail;

function setup(initial: RoomDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (room: RoomDetail) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/rooms/r1/settings/roles"]}>
        <RolesTab room={room} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const r = render(view(initial));
  return { update: (room: RoomDetail) => r.rerender(view(room)) };
}

const nameInput = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
const send = () => screen.getByRole("checkbox", { name: "Send messages" }) as HTMLInputElement;

describe("RoleEditor: changes from elsewhere", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
    mockFetch({});
  });

  it("an untouched form follows an update of the role", () => {
    const { update } = setup(roomWith({}));
    expect(send().checked).toBe(false);
    update(roomWith({ name: "Painters", permissions: VIEW | SEND }));
    expect(nameInput().value).toBe("Painters");
    expect(send().checked).toBe(true);
    expect(screen.queryByTestId("role-changed-elsewhere")).toBeNull();
  });

  it("keeps edits in progress, every field alike, and offers the newer version", async () => {
    const { update } = setup(roomWith({}));
    fireEvent.change(nameInput(), { target: { value: "Sculptors" } });
    update(roomWith({ name: "Painters", permissions: VIEW | SEND, color: "#ff0000" }));
    // Neither the permissions nor the name are overwritten: the form stays what the user is editing.
    expect(nameInput().value).toBe("Sculptors");
    expect(send().checked).toBe(false);
    expect(screen.getByTestId("role-changed-elsewhere")).toHaveTextContent("changed");
    await act(() => userEvent.setup().click(screen.getByTestId("role-changed-reload")));
    expect(nameInput().value).toBe("Painters");
    expect(send().checked).toBe(true);
    expect(screen.queryByTestId("role-changed-elsewhere")).toBeNull();
  });

  it("the role coming back from the own save is no change from elsewhere", () => {
    const { update } = setup(roomWith({}));
    fireEvent.change(nameInput(), { target: { value: "Sculptors" } });
    fireEvent.click(send());
    update(roomWith({ name: "Sculptors", permissions: VIEW | SEND }));
    expect(screen.queryByTestId("role-changed-elsewhere")).toBeNull();
    expect(nameInput().value).toBe("Sculptors");
    // A later change from elsewhere on the untouched form is taken over again.
    update(roomWith({ name: "Sculptors", permissions: VIEW }));
    expect(send().checked).toBe(false);
  });
});
