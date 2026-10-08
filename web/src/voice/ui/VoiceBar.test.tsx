// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../../components/ContextMenu";

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "g", toJSON: () => ({}) }) as MediaDeviceInfo;
const media = vi.hoisted(() => ({ devices: [] as MediaDeviceInfo[], needsPermission: false, unlock: vi.fn(async () => undefined) }));

vi.mock("../devices", async (original) => ({ ...(await original<typeof import("../devices")>()), useMediaDevices: () => media }));
vi.mock("../index", () => ({ toggleMute: vi.fn(async () => undefined), toggleDeafen: vi.fn(async () => undefined), leaveVoice: vi.fn(async () => undefined) }));
vi.mock("../calls/CallUi", () => ({ CallOverlay: () => null, openCallView: vi.fn() }));
vi.mock("./QualityBadge", () => ({ QualityBadge: () => null }));
vi.mock("../../stores/nodes", () => ({ apiFor: () => ({ rooms: { get: async () => ({ name: "Stammtisch", channels: [] }) }, conversations: { get: async () => ({}) } }) }));

const { VoiceBar } = await import("./VoiceBar");
const { toggleDeafen, toggleMute } = await import("../index");
const { useVoice, IDLE } = await import("../store");
const { DEFAULT_SETTINGS, useVoiceSettings } = await import("../settings");

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/rooms/r"]}>
        <Routes>
          <Route path="/settings/voice" element={<p data-testid="settings-page">settings</p>} />
          <Route path="*" element={<VoiceBar />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 30, clientY: 40 });
const sinkProto = HTMLMediaElement.prototype as unknown as { setSinkId?: unknown };

beforeEach(() => {
  localStorage.clear();
  media.devices = [device("audioinput", "default", "Standard"), device("audioinput", "mic-1", "Headset-Mikrofon"), device("audiooutput", "out-1", "Kopfhörer"), device("audiooutput", "out-2", "Lautsprecher")];
  media.needsPermission = false;
  media.unlock.mockClear();
  vi.mocked(toggleMute).mockClear();
  vi.mocked(toggleDeafen).mockClear();
  useVoiceSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useVoice.setState({ ...IDLE, status: "connected", target: { domain: "", roomId: "r", channelId: "c" } });
  sinkProto.setSinkId = vi.fn();
});

afterEach(() => {
  delete sinkProto.setSinkId;
  vi.useRealTimers();
});

describe("VoiceBar quick menus", () => {
  it("right-click on the microphone opens its menu without muting; a microphone applies to the settings", async () => {
    const user = userEvent.setup();
    renderBar();
    rightClick(screen.getByTestId("voice-bar-mute"));
    const menu = screen.getByRole("menu", { name: "Mikrofon-Optionen" });
    expect(toggleMute).not.toHaveBeenCalled();
    expect(within(menu).getByText("Mikrofon")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Systemstandard" })).toHaveAttribute("aria-checked", "true");
    // Only named microphones: no speakers, no duplicate of the browser's default alias.
    expect(within(menu).getAllByRole("menuitemcheckbox").map((e) => e.getAttribute("data-menu-item"))).toEqual(["device:", "device:mic-1", "ptt"]);
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Headset-Mikrofon" }));
    expect(useVoiceSettings.getState().settings.inputDeviceId).toBe("mic-1");
    expect(screen.queryByRole("menu")).toBeNull();
    // Left click still mutes.
    await user.click(screen.getByTestId("voice-bar-mute"));
    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("toggles push-to-talk from the menu, which stays open", async () => {
    const user = userEvent.setup();
    renderBar();
    rightClick(screen.getByTestId("voice-bar-mute"));
    const ptt = screen.getByRole("menuitemcheckbox", { name: /Push-to-Talk/ });
    expect(ptt).toHaveAttribute("aria-checked", "false");
    await user.click(ptt);
    expect(useVoiceSettings.getState().settings.inputMode).toBe("ptt");
    expect(screen.getByRole("menuitemcheckbox", { name: /Push-to-Talk/ })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Push-to-Talk/ }));
    expect(useVoiceSettings.getState().settings.inputMode).toBe("vad");
  });

  it("“Show devices” asks for the device names while they are hidden", async () => {
    const user = userEvent.setup();
    media.devices = [device("audioinput", "", ""), device("audiooutput", "", "")];
    media.needsPermission = true;
    renderBar();
    rightClick(screen.getByTestId("voice-bar-mute"));
    await user.click(screen.getByRole("menuitem", { name: "Geräte anzeigen" }));
    expect(media.unlock).toHaveBeenCalledTimes(1);
  });

  it("“Voice settings…” opens the voice settings", async () => {
    const user = userEvent.setup();
    renderBar();
    rightClick(screen.getByTestId("voice-bar-deafen"));
    await user.click(screen.getByRole("menuitem", { name: "Sprachchat-Einstellungen…" }));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("right-click on the headphones lists the speakers; choosing one sets the output device", async () => {
    const user = userEvent.setup();
    useVoiceSettings.getState().update({ outputDeviceId: "out-2" });
    renderBar();
    rightClick(screen.getByTestId("voice-bar-deafen"));
    const menu = screen.getByRole("menu", { name: "Ausgabe-Optionen" });
    expect(toggleDeafen).not.toHaveBeenCalled();
    expect(within(menu).getByText("Ausgabe")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Lautsprecher" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Kopfhörer" }));
    expect(useVoiceSettings.getState().settings.outputDeviceId).toBe("out-1");
  });

  it("without setSinkId the output menu says so instead of listing devices", () => {
    delete sinkProto.setSinkId;
    renderBar();
    rightClick(screen.getByTestId("voice-bar-deafen"));
    const menu = screen.getByRole("menu", { name: "Ausgabe-Optionen" });
    expect(within(menu).queryAllByRole("menuitemcheckbox")).toEqual([]);
    expect(within(menu).getByRole("menuitem", { name: "Dieser Browser unterstützt keine Auswahl des Ausgabegeräts" })).toHaveAttribute("aria-disabled", "true");
  });

  it("a long press opens the menu on touch devices and does not toggle deafen", () => {
    vi.useFakeTimers();
    renderBar();
    const button = screen.getByTestId("voice-bar-deafen");
    fireEvent.touchStart(button, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    fireEvent.touchEnd(button, { touches: [] });
    fireEvent.click(button);
    expect(screen.getByRole("menu", { name: "Ausgabe-Optionen" })).toBeInTheDocument();
    expect(toggleDeafen).not.toHaveBeenCalled();
  });
});
