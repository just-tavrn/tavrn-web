// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTab } from "./AppTab";
import { resetPlatform, setPlatform } from "../../platform";
import type { AvailableUpdate, Platform } from "../../platform";
import { renderWithProviders } from "../../test/render";
import { cryptoStore } from "../../crypto";
import type { KeyProtection } from "../../crypto/store";
import type { KeychainStatus } from "../../platform/types";
import { useAuth } from "../../stores/auth";

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

describe("AppTab: keys, tray and quit", () => {
  const tray = () => {
    const state = { closeToTray: true };
    return {
      state,
      set: vi.fn(async () => {}),
      onAction: () => () => {},
      status: vi.fn(async () => ({ state: "disconnected" as const, tooltip: "tavrn", available: true, closeToTray: state.closeToTray })),
      setCloseToTray: vi.fn(async (on: boolean) => void (state.closeToTray = on)),
      quit: vi.fn(async () => {}),
    };
  };
  const keystore = (backend: KeychainStatus["backend"]) => ({ status: async () => ({ backend, available: backend !== "none" }), get: async () => null, set: async () => {}, delete: async () => {} });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuth.setState({ user: null });
  });

  function withShell(protection: KeyProtection, backend: KeychainStatus["backend"], t = tray()) {
    setPlatform({ ...desktop(), keystore: keystore(backend), tray: t });
    useAuth.setState({ user: { address: "alice@tavrn.example" } as never });
    vi.spyOn(cryptoStore, "keyProtection").mockResolvedValue(protection);
    return t;
  }

  it("names the keychain that holds the key", async () => {
    withShell("keychain", "secret-service");
    renderWithProviders(<AppTab />);
    expect(await screen.findByText(/Secret Service deines Desktops/)).toBeInTheDocument();
    expect(screen.queryByTestId("app-keys-fallback")).toBeNull();
    expect(cryptoStore.keyProtection).toHaveBeenCalledWith("alice@tavrn.example");
  });

  it("warns visibly when the keychain is not available (fallback)", async () => {
    withShell("fallback", "none");
    renderWithProviders(<AppTab />);
    expect(await screen.findByTestId("app-keys-fallback")).toHaveAttribute("role", "alert");
  });

  it("switches close to tray and quits", async () => {
    const t = withShell("keychain", "credential-manager");
    renderWithProviders(<AppTab />);
    const u = userEvent.setup();
    const box = await screen.findByRole("checkbox", { name: /In den Infobereich schließen/ });
    await vi.waitFor(() => expect(box).toBeChecked());
    await u.click(box);
    expect(t.setCloseToTray).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(box).not.toBeChecked());
    await u.click(screen.getByRole("button", { name: "tavrn beenden" }));
    expect(t.quit).toHaveBeenCalled();
  });

  it("says when the desktop has no tray", async () => {
    const t = tray();
    t.status.mockResolvedValue({ state: "disconnected", tooltip: "tavrn", available: false, closeToTray: false });
    withShell("keychain", "secret-service", t);
    renderWithProviders(<AppTab />);
    expect(await screen.findByTestId("app-tray-unavailable")).toBeInTheDocument();
  });
});
