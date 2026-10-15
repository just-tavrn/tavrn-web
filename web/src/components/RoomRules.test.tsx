// SPDX-License-Identifier: Apache-2.0
// A room's rules are Markdown (PROTOCOL.md `rules`, like `bio`): the invite page, the join dialog and the settings'
// preview render paragraphs, lists and emphasis; raw HTML stays text and never runs.
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, type RoomDetail } from "@tavrn/sdk";
import { InvitePage } from "../pages/InvitePage";
import { CreateRoomDialog } from "./CreateRoomDialog";
import { OverviewTab } from "../pages/settings/OverviewTab";
import { useAuth } from "../stores/auth";
import { useLocale } from "../i18n";
import { mockFetch, renderWithProviders } from "../test/render";

const RULES = "Be kind.\n\n- No spam\n- **No** ads\n\n<script>window.pwned = true</script><img src=x onerror=alert(1)>";
const preview = { code: "abc", rules: RULES, room: { id: "r1", name: "Taverne", description: "", member_count: 3, icon_blob_id: null, icon_animated: false, join_mode: "invite" } };

function expectRendered(rules: HTMLElement) {
  expect(within(rules).getByText("Be kind.").tagName).toBe("P");
  const items = within(rules).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual(["No spam", "No ads"]);
  expect(within(items[1]!).getByText("No").tagName).toBe("STRONG");
  expect(rules.querySelector("script, img")).toBeNull();
  expect(rules.textContent).toContain("<script>window.pwned = true</script>");
  expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
}

describe("room rules as Markdown", () => {
  beforeEach(() => {
    useAuth.setState({ token: "acc" });
    useLocale.setState({ locale: "en" });
  });

  it("the invite page renders them and keeps raw HTML as text", async () => {
    mockFetch({ "/invites/abc": { body: preview } });
    renderWithProviders(
      <Routes>
        <Route path="/invite/:code" element={<InvitePage />} />
      </Routes>,
      { route: "/invite/abc" },
    );
    const rules = await screen.findByRole("region", { name: "Rules" });
    expectRendered(rules);
    expect(screen.getByRole("checkbox", { name: "I accept the rules" })).not.toBeChecked();
  });

  it("the join dialog renders them in a compact scroll box", async () => {
    mockFetch({ "/invites/AbC123": { body: { ...preview, code: "AbC123" } } });
    renderWithProviders(<CreateRoomDialog open onClose={() => {}} onCreated={() => {}} />);
    const u = userEvent.setup();
    await u.click(screen.getByTestId("tab-join-invite"));
    await u.type(screen.getByRole("textbox", { name: /invite/i }), "AbC123{Enter}");
    const rules = await screen.findByRole("region", { name: "Rules" });
    expectRendered(rules);
    expect(rules.className).toContain("max-h-48");
    expect(rules).toHaveAttribute("tabindex", "0");
  });

  it("the settings say Markdown works and preview the text being edited", async () => {
    mockFetch({});
    const room = { id: "r1", name: "Taverne", description: "", rules: "", join_mode: "invite", discoverable: false, owner_id: "me", categories: [], channels: [], roles: [], overrides: [], my_roles: [], my_permissions: ALL_PERMISSIONS.toString(), is_owner: true, read_states: [], member_count: 1 } as unknown as RoomDetail;
    renderWithProviders(<OverviewTab room={room} />);
    const u = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Rules" });
    expect(field).toHaveAccessibleDescription(/Markdown: paragraphs, lists, \*\*bold\*\*, links\./);
    const toggle = screen.getByRole("button", { name: "Preview" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await u.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("No rules yet.")).toBeInTheDocument();
    await u.click(field);
    await u.paste(RULES);
    expectRendered(screen.getByRole("region", { name: "Rules" }));
    await u.click(toggle);
    expect(screen.queryByRole("region", { name: "Rules" })).toBeNull();
  });
});
