// SPDX-License-Identifier: Apache-2.0
/**
 * The camera button's menu (issue #75: front/back on phones, the camera list on desktops) and the Android app's audio
 * output switch (issue #76), as the voice controls use them (the tests run in German).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../../components/ContextMenu";
import { resetPlatform, setPlatform } from "../../platform";
import { androidPlatform, fakeAndroid } from "../../platform/androidTestPlatform";

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "g", toJSON: () => ({}) }) as MediaDeviceInfo;
const media = vi.hoisted(() => ({ devices: [] as MediaDeviceInfo[], needsPermission: false, unlock: vi.fn(async () => undefined) }));
vi.mock("../devices", async (original) => ({ ...(await original<typeof import("../devices")>()), useMediaDevices: () => media }));

const { ControlButton } = await import("./VoiceBar");
const { useVoiceDeviceMenu } = await import("./VoiceDeviceMenu");
const { AudioRouteButton } = await import("./AudioRouteButton");
const { DEFAULT_SETTINGS, useVoiceSettings } = await import("../settings");

const toggleCamera = vi.fn();

/** The camera button as the voice controls render it. */
function CameraButton() {
  const menu = useVoiceDeviceMenu("camera");
  return (
    <>
      <ControlButton label="Kamera einschalten" onClick={toggleCamera} testid="voice-camera" menu={menu.triggerProps}>
        cam
      </ControlButton>
      {menu.overlay}
    </>
  );
}

function renderControls() {
  return render(
    <MemoryRouter initialEntries={["/rooms/r"]}>
      <Routes>
        <Route path="/settings/voice" element={<p data-testid="settings-page">settings</p>} />
        <Route
          path="*"
          element={
            <>
              <CameraButton />
              <AudioRouteButton />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** A touch device (phones): `(pointer: coarse)` matches. */
function touchScreen(coarse: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ ...original(query), matches: coarse && query.includes("coarse") })) as typeof window.matchMedia;
  return () => (window.matchMedia = original);
}

let restore = () => {};

beforeEach(() => {
  localStorage.clear();
  media.devices = [device("videoinput", "cam-1", "Integrierte Kamera"), device("videoinput", "cam-2", "USB-Kamera"), device("audioinput", "mic-1", "Mikrofon")];
  media.needsPermission = false;
  toggleCamera.mockClear();
  useVoiceSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

afterEach(() => {
  restore();
  resetPlatform();
  vi.useRealTimers();
});

describe("the camera button's menu", () => {
  it("on a phone a long press offers the front and the back camera; the choice is remembered", async () => {
    restore = touchScreen(true);
    vi.useFakeTimers();
    renderControls();
    const button = screen.getByTestId("voice-camera");
    fireEvent.touchStart(button, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.touchEnd(button);
    fireEvent.click(button);
    // The long press opened the menu instead of turning the camera on.
    expect(toggleCamera).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "Kamera-Optionen" });
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((i) => [i.getAttribute("data-menu-item"), i.textContent?.replace("✓", ""), i.getAttribute("aria-checked")])).toEqual([
      ["facing:user", "Frontkamera", "true"],
      ["facing:environment", "Rückkamera", "false"],
    ]);
    expect(within(menu).queryByText("Integrierte Kamera")).toBeNull();
    vi.useRealTimers();
    await userEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Rückkamera" }));
    expect(useVoiceSettings.getState().settings.cameraFacing).toBe("environment");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Rückkamera" })).toHaveAttribute("aria-checked", "true");
  });

  it("on a desktop a right-click lists the cameras and links to the settings; a click still turns the camera on", async () => {
    restore = touchScreen(false);
    const user = userEvent.setup();
    renderControls();
    fireEvent.contextMenu(screen.getByTestId("voice-camera"), { clientX: 30, clientY: 40 });
    const menu = screen.getByRole("menu", { name: "Kamera-Optionen" });
    expect(within(menu).getAllByRole("menuitemcheckbox").map((i) => i.getAttribute("data-menu-item"))).toEqual(["device:", "device:cam-1", "device:cam-2"]);
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "USB-Kamera" }));
    expect(useVoiceSettings.getState().settings.cameraDeviceId).toBe("cam-2");
    await user.click(within(menu).getByRole("menuitem", { name: "Einstellungen…" }));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("a plain click turns the camera on and opens no menu", async () => {
    renderControls();
    await userEvent.click(screen.getByTestId("voice-camera"));
    expect(toggleCamera).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the audio output switch", () => {
  it("is not there outside the Android app", () => {
    renderControls();
    expect(screen.queryByTestId("voice-route")).toBeNull();
  });

  it("names the route in use and moves the call's audio from its menu", async () => {
    const android = fakeAndroid({ routes: { available: ["speaker", "earpiece"], current: "speaker" } });
    setPlatform(androidPlatform(android));
    const user = userEvent.setup();
    renderControls();
    const button = await screen.findByRole("button", { name: "Audioausgabe: Lautsprecher" });
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    const menu = screen.getByRole("menu", { name: "Audioausgabe" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getAllByRole("menuitemcheckbox").map((i) => [i.getAttribute("data-menu-item"), i.textContent?.replace("✓", ""), i.getAttribute("aria-checked")])).toEqual([
      ["route:speaker", "Lautsprecher", "true"],
      ["route:earpiece", "Hörmuschel", "false"],
    ]);
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Hörmuschel" }));
    expect(android.audio.setRoute).toHaveBeenCalledWith("earpiece");
    await screen.findByRole("button", { name: "Audioausgabe: Hörmuschel" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("follows a headset that connects", async () => {
    const android = fakeAndroid();
    setPlatform(androidPlatform(android));
    renderControls();
    await screen.findByRole("button", { name: "Audioausgabe: Lautsprecher" });
    act(() => android.emitRoutes({ available: ["speaker", "earpiece", "bluetooth"], current: "bluetooth" }));
    await waitFor(() => expect(screen.getByTestId("voice-route")).toHaveAttribute("data-route", "bluetooth"));
    expect(screen.getByRole("button", { name: "Audioausgabe: Bluetooth-Headset" })).toBeInTheDocument();
  });
});
