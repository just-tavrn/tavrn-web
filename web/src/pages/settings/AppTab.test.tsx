// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTab } from "./AppTab";
import { resetPlatform, setPlatform } from "../../platform";
import type { Platform } from "../../platform";
import { renderWithProviders } from "../../test/render";
import { cryptoStore } from "../../crypto";
import type { BiometricState, KeyProtection } from "../../crypto/store";
import type { AppUpdater, KeychainStatus, UpdateChannel } from "../../platform/types";
import { updateFailure } from "../../platform/updateErrors";
import { useAuth } from "../../stores/auth";
import { useE2ee } from "../../stores/e2ee";
import { UnlockError } from "../../platform/unlockError";

function desktop(updater?: AppUpdater): Platform {
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

  it.each([
    ["update.unreachable", /Update-Server ist nicht erreichbar/],
    ["update.no_release", /In diesem Update-Kanal gibt es noch kein Release/],
    ["update.signature_invalid", /Das Update wurde abgelehnt/],
    ["update.failed", /Das Update hat nicht geklappt/],
  ])("names why the check failed: %s", async (code, text) => {
    desktop({ check: async () => updateFailure(code) });
    renderWithProviders(<AppTab />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText("Etwas ist schiefgelaufen")).toBeNull();
  });

  it("shows the update channel and stores a new choice; the next check asks that channel", async () => {
    let channel: UpdateChannel = "beta";
    const set = vi.fn(async (c: UpdateChannel) => void (channel = c));
    const check = vi.fn(async () => null);
    desktop({ check, channel: { get: async () => channel, set } });
    renderWithProviders(<AppTab />);
    const u = userEvent.setup();
    const select = await screen.findByRole("combobox", { name: "Update-Kanal" });
    await vi.waitFor(() => expect(select).toHaveValue("beta"));
    expect(screen.getByRole("option", { name: "Stabil" })).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Nach Updates suchen" }));
    expect(await screen.findByTestId("app-up-to-date")).toBeInTheDocument();
    await u.selectOptions(select, "stable");
    expect(set).toHaveBeenCalledWith("stable");
    await vi.waitFor(() => expect(select).toHaveValue("stable"));
    // A new channel means a new answer: the old "newest version" note goes.
    expect(screen.queryByTestId("app-up-to-date")).toBeNull();
  });

  it("keeps the old channel when the shell refuses the new one", async () => {
    desktop({ check: async () => null, channel: { get: async () => "stable", set: async () => updateFailure("update.channel_invalid") } });
    renderWithProviders(<AppTab />);
    const select = await screen.findByRole("combobox", { name: "Update-Kanal" });
    await vi.waitFor(() => expect(select).toHaveValue("stable"));
    await userEvent.setup().selectOptions(select, "beta");
    expect(await screen.findByText("Diesen Update-Kanal gibt es nicht.")).toBeInTheDocument();
    await vi.waitFor(() => expect(select).toHaveValue("stable"));
  });

  it("offers no channel without an updater", async () => {
    desktop();
    renderWithProviders(<AppTab />);
    await screen.findByTestId("app-updates-unconfigured");
    expect(screen.queryByRole("combobox", { name: "Update-Kanal" })).toBeNull();
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

describe("AppTab in the Android app: unlock with fingerprint, face or PIN", () => {
  const unlock = { status: async () => ({ available: "ready" as const, stored: "none" as const }), store: async () => {}, get: async () => new Uint8Array(32), clear: async () => {} };

  function android(state: BiometricState, protection: KeyProtection, status: "unlocked" | "locked" = "unlocked") {
    setPlatform({ ...desktop(), kind: "android", unlock });
    useAuth.setState({ user: { address: "alice@tavrn.example" } as never });
    useE2ee.setState({ status });
    const current = { state, protection };
    vi.spyOn(cryptoStore, "keyProtection").mockImplementation(async () => current.protection);
    vi.spyOn(cryptoStore, "biometricState").mockImplementation(async () => current.state);
    const enable = vi.spyOn(cryptoStore, "enableBiometric").mockImplementation(async () => {
      current.state = { ...current.state, on: true };
      current.protection = "biometric";
    });
    const disable = vi.spyOn(cryptoStore, "disableBiometric").mockImplementation(async () => {
      current.state = { ...current.state, on: false };
      current.protection = "browser";
    });
    return { enable, disable };
  }

  const off: BiometricState = { available: "ready", on: false, invalidated: false, lockOnClose: false };

  afterEach(() => {
    vi.restoreAllMocks();
    useAuth.setState({ user: null });
  });

  it("turns it on through the prompt and off again, and says where the key is", async () => {
    const { enable, disable } = android(off, "browser");
    renderWithProviders(<AppTab />);
    const box = await screen.findByRole("checkbox", { name: /^Mit Fingerabdruck, Gesicht oder PIN entsperren/ });
    expect(screen.getByTestId("app-keys")).toHaveTextContent("im Speicher der App");
    await vi.waitFor(() => expect(box).toBeEnabled());
    const u = userEvent.setup();
    await u.click(box);
    expect(enable).toHaveBeenCalledWith({ title: "Entsperren mit Fingerabdruck, Gesicht oder PIN einschalten", subtitle: "alice@tavrn.example" });
    await vi.waitFor(() => expect(box).toBeChecked());
    expect(await screen.findByText(/im Schlüsselspeicher von Android versiegelt: Er öffnet sich nur/)).toBeInTheDocument();
    await u.click(box);
    expect(disable).toHaveBeenCalledWith("alice@tavrn.example");
    await vi.waitFor(() => expect(box).not.toBeChecked());
  });

  it("a closed prompt changes nothing and shows no error", async () => {
    const { enable } = android(off, "browser");
    enable.mockRejectedValueOnce(new UnlockError("cancelled"));
    renderWithProviders(<AppTab />);
    const box = await screen.findByRole("checkbox", { name: /^Mit Fingerabdruck, Gesicht oder PIN entsperren/ });
    await vi.waitFor(() => expect(box).toBeEnabled());
    await userEvent.setup().click(box);
    await vi.waitFor(() => expect(box).not.toBeChecked());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [{ ...off, available: "no_lock" as const }, "unlocked" as const, /Displaysperre/],
    [{ ...off, available: "unsupported" as const }, "unlocked" as const, /Android 11/],
    [off, "locked" as const, /Entsperre zuerst/],
  ])("cannot be turned on: %o (%s)", async (state, status, reason) => {
    android(state, "browser", status);
    renderWithProviders(<AppTab />);
    const box = await screen.findByRole("checkbox", { name: /^Mit Fingerabdruck, Gesicht oder PIN entsperren/ });
    expect(box).toBeDisabled();
    expect(screen.getByTestId("app-biometric-reason")).toHaveTextContent(reason);
  });

  it("can always be turned off, also while locked", async () => {
    const { disable } = android({ ...off, on: true }, "biometric", "locked");
    renderWithProviders(<AppTab />);
    const box = await screen.findByRole("checkbox", { name: /^Mit Fingerabdruck, Gesicht oder PIN entsperren/ });
    await vi.waitFor(() => expect(box).toBeChecked());
    expect(box).toBeEnabled();
    await userEvent.setup().click(box);
    expect(disable).toHaveBeenCalled();
  });

  it("is not there on the desktop", async () => {
    setPlatform(desktop());
    useAuth.setState({ user: { address: "alice@tavrn.example" } as never });
    renderWithProviders(<AppTab />);
    await screen.findByTestId("app-version");
    expect(screen.queryByTestId("app-biometric")).toBeNull();
  });
});
