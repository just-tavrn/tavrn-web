// SPDX-License-Identifier: Apache-2.0
/**
 * The notification settings in the Android app (docs/ANDROID.md "Notifications without Google"): push through
 * UnifiedPush with the hints for a missing distributor, the connection service and the battery exemption, every
 * control named for assistive technology (the tests run in German).
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationsTab } from "./NotificationsTab";
import { resetPlatform, setPlatform } from "../../platform";
import { androidPlatform, fakeAndroid } from "../../platform/androidTestPlatform";
import { usePush } from "../../stores/push";
import { renderWithProviders } from "../../test/render";

beforeEach(() => {
  localStorage.clear();
  usePush.getState().reset();
});

afterEach(() => {
  resetPlatform();
  usePush.getState().reset();
});

describe("NotificationsTab in the Android app", () => {
  it("shows push with UnifiedPush's hints and no browser permission switch", async () => {
    const android = fakeAndroid();
    setPlatform({ ...androidPlatform(android), notifications: { show: async () => {}, onOpen: () => () => {} } });
    usePush.setState({ status: "no_distributor" });
    renderWithProviders(<NotificationsTab />);
    expect(screen.getByTestId("push-settings")).toHaveAttribute("data-status", "no_distributor");
    expect(screen.queryByTestId("notify-browser")).toBeNull();
    expect(screen.getByTestId("push-hint")).toHaveTextContent("Keine UnifiedPush-App auf diesem Gerät gefunden");
    expect(screen.getByRole("link", { name: "ntfy bei F-Droid" })).toHaveAttribute("href", "https://f-droid.org/packages/io.heckel.ntfy/");
    expect(screen.getByRole("link", { name: "UnifiedPush-Apps" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Push-Benachrichtigungen auf diesem Gerät/ })).toBeDisabled();
    // The connection service instead, with its battery warning in its description.
    const keep = screen.getByRole("checkbox", { name: /Verbindung für Benachrichtigungen halten/ });
    await userEvent.click(keep);
    await waitFor(() => expect(android.keepConnection).toHaveBeenCalledWith(true, { title: "tavrn bleibt verbunden", text: expect.any(String) }));
    expect(localStorage.getItem("tavrn.android.keepConnection")).toBe("on");
    // The battery exemption through the system's dialog, offered with an explanation.
    await userEvent.click(await screen.findByRole("button", { name: "Von der Akku-Optimierung ausnehmen" }));
    expect(android.requestBatteryExemption).toHaveBeenCalled();
  });

  it("points to Android's settings when notifications are off there", async () => {
    const android = fakeAndroid();
    setPlatform({ ...androidPlatform(android), notifications: { show: async () => {}, onOpen: () => () => {} } });
    usePush.setState({ status: "denied" });
    renderWithProviders(<NotificationsTab />);
    expect(screen.getByTestId("push-hint")).toHaveTextContent("für tavrn in den Android-Einstellungen ausgeschaltet");
    await userEvent.click(screen.getByRole("button", { name: "Android-Einstellungen öffnen" }));
    expect(android.openSettings).toHaveBeenCalledWith("notifications");
  });
});
