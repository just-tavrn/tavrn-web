// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell (responsive)", () => {

  it("opens and closes the navigation with the toggle", async () => {
    const user = userEvent.setup();
    render(<AppShell sidebar={<span>Channelliste</span>}>Inhalt</AppShell>);
    const drawer = screen.getByTestId("nav-drawer");
    expect(drawer).toHaveAttribute("data-open", "false");
    await user.click(screen.getByRole("button", { name: "Navigation öffnen" }));
    expect(drawer).toHaveAttribute("data-open", "true");
    expect(screen.getByRole("button", { name: "Navigation öffnen" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Drawer schließen" }));
    expect(drawer).toHaveAttribute("data-open", "false");
  });

  it("opens the member list as a drawer", async () => {
    const user = userEvent.setup();
    render(<AppShell aside={<span>Mitglied A</span>}>Inhalt</AppShell>);
    await user.click(screen.getByRole("button", { name: "Mitglieder öffnen" }));
    expect(screen.getByTestId("members-drawer")).toHaveAttribute("data-open", "true");
    expect(screen.getByText("Mitglied A")).toBeInTheDocument();
  });

  it("has touch targets of at least 44px for the drawer toggles", () => {
    render(<AppShell aside={<span>Mitglied A</span>}>Inhalt</AppShell>);
    for (const name of ["Navigation öffnen", "Mitglieder öffnen"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11", "min-w-11");
    }
  });

  it("pages without a member list (friends, discover, settings) get the full width and no member toggle", () => {
    const { unmount } = render(<AppShell aside={null}>Inhalt</AppShell>);
    expect(screen.queryByRole("button", { name: "Mitglieder öffnen" })).not.toBeInTheDocument();
    // The drawer element stays (hidden) so helpers can still read its state; the desktop grid drops its column.
    expect(screen.getByTestId("members-drawer")).toHaveClass("hidden");
    expect(screen.getByTestId("app-shell").className).toContain("xl:grid-cols-[72px_240px_1fr]");
    expect(screen.getByTestId("app-shell").className).not.toContain("1fr_240px");
    unmount();
    render(<AppShell aside={<span>Mitglied A</span>}>Inhalt</AppShell>);
    expect(screen.getByTestId("members-drawer")).not.toHaveClass("hidden");
    expect(screen.getByTestId("app-shell").className).toContain("xl:grid-cols-[72px_240px_1fr_240px]");
  });
});
