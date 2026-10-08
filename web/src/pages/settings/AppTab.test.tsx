// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTab } from "./AppTab";
import { resetPlatform, setPlatform } from "../../platform";
import type { AvailableUpdate, Platform } from "../../platform";
import { renderWithProviders } from "../../test/render";

function desktop(updater?: { check: () => Promise<AvailableUpdate | null> }): Platform {
  const p: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => "https://tavrn.example",
    webOrigin: () => "https://tavrn.example",
    openExternal: async () => {},
    appVersion: async () => "0.2.0",
    node: { current: () => "https://tavrn.example", set: async () => {} },
    ...(updater ? { updater } : {}),
  };
  setPlatform(p);
  return p;
}

afterEach(() => resetPlatform());

describe("AppTab", () => {
  it("shows the version and the home node with a way to change it", async () => {
    desktop();
    renderWithProviders(<AppTab />);
    expect(await screen.findByText("Version 0.2.0")).toHaveAttribute("data-testid", "app-version");
    expect(screen.getByTestId("app-node")).toHaveTextContent("https://tavrn.example");
    expect(screen.getByRole("link", { name: "Knoten wechseln" })).toHaveAttribute("href", "/node");
  });

  it("says when the build has no updater", async () => {
    desktop();
    renderWithProviders(<AppTab />);
    expect(await screen.findByTestId("app-updates-unconfigured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nach Updates suchen" })).toBeNull();
  });

  it("checks for updates: the newest version", async () => {
    desktop({ check: async () => null });
    renderWithProviders(<AppTab />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByTestId("app-up-to-date")).toBeInTheDocument();
  });

  it("checks for updates: installs a newer version", async () => {
    const install = vi.fn(async () => {});
    desktop({ check: async () => ({ version: "0.3.0", notes: "Neu", install }) });
    renderWithProviders(<AppTab />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByTestId("app-update")).toHaveTextContent("0.3.0");
    await u.click(screen.getByRole("button", { name: "Installieren und neu starten" }));
    expect(install).toHaveBeenCalled();
  });

  it("shows a failed update check", async () => {
    desktop({ check: async () => Promise.reject(new Error("signature invalid")) });
    renderWithProviders(<AppTab />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByText(/signature invalid/)).toBeInTheDocument();
  });
});
