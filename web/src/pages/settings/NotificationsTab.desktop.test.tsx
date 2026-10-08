// SPDX-License-Identifier: Apache-2.0
/**
 * The notification settings in the desktop app (docs/DESKTOP.md "Notifications"): no web push section and no browser
 * permission switch; instead the switch for the app's native notifications, kept on this device.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsTab } from "./NotificationsTab";
import { resetPlatform, setPlatform } from "../../platform";
import type { Platform } from "../../platform/types";
import { desktopNotificationsEnabled } from "../../lib/notify";
import { renderWithProviders } from "../../test/render";

const desktop: Platform = {
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => "https://t.local",
  webOrigin: () => "https://t.local",
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
  notifications: { show: async () => {}, onOpen: () => () => {} },
};

beforeEach(() => {
  localStorage.removeItem("tavrn.desktop.notifications");
  vi.stubGlobal("Notification", Object.assign(function Notification() {}, { permission: "default" }));
});

afterEach(() => {
  resetPlatform();
  vi.unstubAllGlobals();
});

describe("NotificationsTab", () => {
  it("the browser shows web push and the browser permission switch", () => {
    renderWithProviders(<NotificationsTab />);
    expect(screen.getByTestId("push-settings")).toBeInTheDocument();
    expect(screen.getByTestId("notify-browser")).toBeInTheDocument();
    expect(screen.queryByTestId("notify-desktop")).toBeNull();
  });

  it("the desktop app hides web push and offers its native notifications instead", async () => {
    setPlatform(desktop);
    renderWithProviders(<NotificationsTab />);
    expect(screen.queryByTestId("push-settings")).toBeNull();
    expect(screen.queryByTestId("notify-browser")).toBeNull();
    const box = screen.getByRole("checkbox", { name: /Systembenachrichtigungen/ });
    expect(box).toBeChecked();
    await userEvent.setup().click(box);
    expect(box).not.toBeChecked();
    expect(desktopNotificationsEnabled()).toBe(false);
  });
});
