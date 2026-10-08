// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { VoiceQualitySection } from "./VoiceQualitySection";
import { useAuth } from "../../stores/auth";
import { mockFetch, renderWithProviders } from "../../test/render";

const room = { id: "r1", name: "Raum", my_permissions: "0", channels: [], categories: [] } as unknown as RoomDetail;
const channel = (kbps: number) => ({ id: "c1", room_id: "r1", kind: "voice", name: "Lounge", encrypted: true, bitrate_kbps: kbps }) as unknown as Channel;
const node = (cap: number) => ({ body: { voice: { enabled: true, max_bitrate_kbps: cap } } });
const patchBody = (calls: Array<{ url: string; init: RequestInit }>) => {
  const patch = calls.find((c) => c.url.endsWith("/rooms/r1/channels/c1") && c.init.method === "PATCH");
  return patch ? JSON.parse(String(patch.init.body)) : null;
};

describe("VoiceQualitySection (VOICE.md §4a)", () => {
  it("shows the presets, marks those above the node's cap as limited and saves a preset", async () => {
    useAuth.setState({ token: "acc" });
    const calls = mockFetch({ "/node": node(128), "/rooms/r1/channels/c1": { body: channel(128) } });
    let changed = 0;
    renderWithProviders(<VoiceQualitySection channel={channel(64)} room={room} canManage onChanged={async () => void changed++} />);
    expect(screen.getByText("Sprachqualität")).toBeInTheDocument();
    expect(screen.getByTestId("quality-preset-high")).toBeChecked();
    for (const id of ["saver", "standard", "high", "studio", "music", "custom"]) expect(screen.getByTestId(`quality-preset-${id}`)).toBeInTheDocument();
    // The node allows 128: Music (192) is limited and cannot be chosen.
    expect(await screen.findByText("Von diesem Knoten begrenzt (höchstens 128 kbit/s)")).toBeInTheDocument();
    expect(screen.getByTestId("quality-preset-music")).toBeDisabled();
    expect(screen.getByTestId("quality-preset-studio")).toBeEnabled();
    const save = screen.getByTestId("voice-quality-save");
    expect(save).toBeDisabled();
    const u = userEvent.setup();
    await u.click(screen.getByTestId("quality-preset-studio"));
    expect(screen.getByText(/Etwa 58 MB pro Stunde/)).toBeInTheDocument();
    await u.click(save);
    expect(patchBody(calls)).toEqual({ bitrate_kbps: 128 });
    expect(changed).toBe(1);
  });

  it("saves a custom bitrate within the cap", async () => {
    useAuth.setState({ token: "acc" });
    const calls = mockFetch({ "/node": node(192), "/rooms/r1/channels/c1": { body: channel(96) } });
    renderWithProviders(<VoiceQualitySection channel={channel(64)} room={room} canManage onChanged={async () => undefined} />);
    const u = userEvent.setup();
    await u.click(screen.getByTestId("quality-preset-custom"));
    const input = screen.getByTestId("quality-custom-kbps");
    await u.clear(input);
    await u.type(input, "96");
    await u.click(screen.getByTestId("voice-quality-save"));
    expect(patchBody(calls)).toEqual({ bitrate_kbps: 96 });
  });

  it("explains music mode and its traffic", async () => {
    mockFetch({ "/node": node(192) });
    renderWithProviders(<VoiceQualitySection channel={channel(192)} room={room} canManage onChanged={async () => undefined} />);
    expect(screen.getByTestId("quality-preset-music")).toBeChecked();
    expect(screen.getByText(/Musikmodus: Stereo, wenn das Mikrofon zwei Kanäle liefert/)).toBeInTheDocument();
    expect(screen.getByText(/Etwa 86 MB pro Stunde/)).toBeInTheDocument();
  });

  it("shows a stored bitrate above a lowered cap as limited by the node", async () => {
    mockFetch({ "/node": node(128) });
    renderWithProviders(<VoiceQualitySection channel={channel(192)} room={room} canManage onChanged={async () => undefined} />);
    expect(await screen.findByText("Dieser Knoten begrenzt den Kanal auf 128 kbit/s.")).toBeInTheDocument();
  });

  it("is read-only without manage_channels", () => {
    mockFetch({ "/node": node(192) });
    renderWithProviders(<VoiceQualitySection channel={channel(32)} room={room} canManage={false} onChanged={async () => undefined} />);
    expect(screen.getByTestId("quality-preset-standard")).toBeChecked();
    expect(screen.getByTestId("quality-preset-saver")).toBeDisabled();
    expect(screen.queryByTestId("voice-quality-save")).toBeNull();
  });
});
