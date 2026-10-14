// SPDX-License-Identifier: Apache-2.0
// The banner of the role preview (docs/CLIENT.md "View the room as a role"): who is simulated, the approximations
// behind a disclosure, the exit; leaving the room ends the preview.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { RolePreviewBanner } from "./RolePreviewBanner";
import { useRolePreview } from "../stores/rolePreview";

beforeEach(() => {
  useRolePreview.getState().exit();
  useRolePreview.getState().start({ roomId: "r1", roleIds: ["mods"], joinedAt: Date.parse("2026-10-14T12:00:00Z"), label: "Mods" });
});

describe("RolePreviewBanner", () => {
  it("names the roles in a live status, explains the approximations on demand and exits", async () => {
    const user = userEvent.setup();
    render(<RolePreviewBanner roomId="r1" />);
    const banner = screen.getByRole("region", { name: "Rollenvorschau" });
    expect(screen.getByRole("status")).toHaveTextContent("Ansicht als Mods");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    const details = screen.getByRole("button", { name: "Was simuliert wird" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("role-preview-approximations")).not.toBeVisible();
    await user.click(details);
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("role-preview-approximations")).toBeVisible();
    expect(screen.getByTestId("role-preview-approximations")).toHaveTextContent("nicht im Timeout");
    await user.click(screen.getByRole("button", { name: "Vorschau beenden" }));
    expect(useRolePreview.getState().preview).toBeNull();
    expect(banner).not.toBeInTheDocument();
  });

  it("is not shown in another room, and leaving the room ends the preview", () => {
    const { rerender } = render(<RolePreviewBanner roomId="r1" />);
    expect(screen.getByTestId("role-preview-banner")).toBeVisible();
    act(() => rerender(<RolePreviewBanner roomId="r2" />));
    expect(screen.queryByTestId("role-preview-banner")).toBeNull();
    expect(useRolePreview.getState().preview).toBeNull();
  });

  it("a page without a room (friends, DMs) ends it too", () => {
    render(<RolePreviewBanner roomId={undefined} />);
    expect(useRolePreview.getState().preview).toBeNull();
  });
});
