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
vi.mock("./QualityBadge", () => ({ QualityBadge: () => <span data-testid="voice-quality">Hoch</span> }));
vi.mock("../../stores/nodes", () => ({ apiFor: () => ({ rooms: { get: async () => ({ name: "Stammtisch", channels: [] }) }, conversations: { get: async () => ({}) } }) }));

const { VoiceBar, ControlButton } = await import("./VoiceBar");
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

/** A right-click: the right button's pointerdown, then the contextmenu event. */
const rightClick = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { button: 2 });
  fireEvent.contextMenu(el, { clientX: 30, clientY: 40 });
};
/** The menu listens for clicks outside only after the event that opened it. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 5)));
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
    // The menu stays open and moves the check mark.
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Headset-Mikrofon" })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Systemstandard" })).toHaveAttribute("aria-checked", "false");
    // A click outside closes it (and a left click still mutes).
    await settle();
    await user.click(screen.getByTestId("voice-bar-mute"));
    expect(screen.queryByRole("menu")).toBeNull();
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

  it("closes on Escape and on a second right-click on the same button; a right-click on the other button switches menus", async () => {
    const user = userEvent.setup();
    renderBar();
    const mic = screen.getByTestId("voice-bar-mute");
    rightClick(mic);
    await settle();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    rightClick(mic);
    await settle();
    rightClick(mic);
    expect(screen.queryByRole("menu")).toBeNull();
    rightClick(mic);
    await settle();
    rightClick(screen.getByTestId("voice-bar-deafen"));
    expect(screen.queryByRole("menu", { name: "Mikrofon-Optionen" })).toBeNull();
    expect(screen.getByRole("menu", { name: "Ausgabe-Optionen" })).toBeInTheDocument();
    expect(toggleMute).not.toHaveBeenCalled();
    expect(toggleDeafen).not.toHaveBeenCalled();
  });

  it("the sliders change the settings live; the threshold shows only with voice activation", async () => {
    const user = userEvent.setup();
    useVoiceSettings.getState().update({ inputVolume: 100, vadThreshold: -55, outputVolume: 100 });
    renderBar();
    rightClick(screen.getByTestId("voice-bar-mute"));
    const menu = screen.getByRole("menu", { name: "Mikrofon-Optionen" });
    const volume = within(menu).getByRole("slider", { name: "Eingangslautstärke" });
    expect(volume).toHaveValue("100");
    fireEvent.change(volume, { target: { value: "135" } });
    expect(useVoiceSettings.getState().settings.inputVolume).toBe(135);
    expect(within(menu).getByText("135 %")).toBeInTheDocument();
    fireEvent.change(within(menu).getByRole("slider", { name: "Aktivierungsschwelle" }), { target: { value: "-70" } });
    expect(useVoiceSettings.getState().settings.vadThreshold).toBe(-70);
    // Push-to-talk on: the threshold goes away, off: it comes back.
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: /Push-to-Talk/ }));
    expect(within(menu).queryByRole("slider", { name: "Aktivierungsschwelle" })).toBeNull();
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: /Push-to-Talk/ }));
    expect(within(menu).getByRole("slider", { name: "Aktivierungsschwelle" })).toHaveValue("-70");
    // The keyboard reaches the volume slider from the push-to-talk item.
    within(menu).getByRole("menuitemcheckbox", { name: /Push-to-Talk/ }).focus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("slider", { name: "Eingangslautstärke" })).toHaveFocus();
    // The headphones menu has the output volume.
    await settle();
    rightClick(screen.getByTestId("voice-bar-deafen"));
    const output = screen.getByRole("menu", { name: "Ausgabe-Optionen" });
    fireEvent.change(within(output).getByRole("slider", { name: "Ausgangslautstärke" }), { target: { value: "60" } });
    expect(useVoiceSettings.getState().settings.outputVolume).toBe(60);
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

describe("VoiceBar encryption indicator", () => {
  it("shows the padlock inside the signal bars with a text alternative, no lock emoji", () => {
    useVoice.setState({ quality: "excellent" });
    const { container } = renderBar();
    expect(container.textContent ?? "").not.toMatch(/[\u{1F512}\u{1F513}]/u);
    const signal = screen.getByRole("img", { name: "Verschlüsselt · Verbindung gut" });
    expect(signal).toHaveAttribute("title", "Verschlüsselt · Verbindung gut");
    expect(signal.querySelector("svg [data-testid='signal-lock']")).not.toBeNull();
    // Three bars, all filled.
    expect([...signal.querySelectorAll("rect[data-bar]")].map((r) => r.getAttribute("opacity"))).toEqual(["1", "1", "1"]);
  });

  it("names the connection quality and the connecting state", () => {
    useVoice.setState({ quality: "good" });
    const { unmount } = renderBar();
    expect(screen.getByRole("img", { name: "Verschlüsselt · Verbindung okay" })).toBeInTheDocument();
    unmount();
    useVoice.setState({ quality: "poor" });
    const second = renderBar();
    expect(screen.getByRole("img", { name: "Verschlüsselt · Verbindung schwach" })).toBeInTheDocument();
    second.unmount();
    useVoice.setState({ status: "reconnecting", quality: "excellent" });
    renderBar();
    const signal = screen.getByRole("img", { name: "Verschlüsselt · Verbindung wird aufgebaut" });
    expect([...signal.querySelectorAll("rect[data-bar]")].map((r) => r.getAttribute("opacity"))).toEqual(["0.25", "0.25", "0.25"]);
    expect(signal.querySelector("[data-testid='signal-lock']")).not.toBeNull();
  });
});

describe("VoiceBar layout", () => {
  const row = (el: HTMLElement) => el.closest("[data-row]")!;

  it("first line: signal, a short status and the quality badge; second line: channel and room", async () => {
    useVoice.setState({ quality: "excellent" });
    renderBar();
    const status = screen.getByTestId("voice-bar-status");
    expect(status).toHaveTextContent(/^Verbunden$/);
    expect(row(status)).toHaveAttribute("data-row", "status");
    expect(row(status)).toHaveClass("whitespace-nowrap");
    expect(row(status)).toContainElement(screen.getByTestId("voice-bar-signal"));
    expect(row(status)).toContainElement(screen.getByTestId("voice-quality"));
    const channel = screen.getByTestId("voice-bar-channel");
    expect(row(channel)).toHaveAttribute("data-row", "channel");
    // Compact 36 px controls leave the first line room for status and badge in a 240 px sidebar.
    for (const id of ["voice-bar-mute", "voice-bar-deafen", "voice-bar-leave"]) expect(screen.getByTestId(id)).toHaveClass("min-w-9", "min-h-9");
    expect(channel).toHaveClass("truncate");
    expect(await screen.findByText("Stammtisch", { exact: false })).toBe(channel);
    // Screen readers get the long form; the button opens the channel.
    expect(screen.getByRole("button", { name: /Sprache verbunden/ })).toHaveAttribute("title", "Sprachkanal öffnen");
  });

  it("short forms while connecting and reconnecting; cancel stays reachable", () => {
    useVoice.setState({ status: "joining" });
    const first = renderBar();
    expect(screen.getByTestId("voice-bar-status")).toHaveTextContent(/^Verbinde…$/);
    expect(screen.queryByTestId("voice-quality")).toBeNull();
    first.unmount();
    useVoice.setState({ status: "reconnecting" });
    renderBar();
    expect(screen.getByTestId("voice-bar-status")).toHaveTextContent(/^Verbinde neu…$/);
    expect(screen.getByTestId("voice-bar-cancel")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-testid"))).toEqual([null, "voice-bar-mute", "voice-bar-deafen", "voice-bar-leave", "voice-bar-cancel"]);
  });
});

describe("an unavailable control", () => {
  it("stays focusable, names the reason and does nothing (the native voice engine has no camera)", async () => {
    const onClick = vi.fn();
    render(
      <ControlButton label="Kamera einschalten" unavailable="mit der nativen Sprach-Engine nicht verfügbar" onClick={onClick} testid="voice-camera">
        x
      </ControlButton>,
    );
    const button = screen.getByRole("button", { name: "Kamera einschalten: mit der nativen Sprach-Engine nicht verfügbar" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("aria-pressed");
    button.focus();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
