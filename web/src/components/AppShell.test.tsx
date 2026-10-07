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
    render(<AppShell>Inhalt</AppShell>);
    for (const name of ["Navigation öffnen", "Mitglieder öffnen"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11", "min-w-11");
    }
  });
});
