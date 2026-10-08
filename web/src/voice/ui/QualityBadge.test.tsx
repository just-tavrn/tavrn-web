// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceLimits } from "@tavrn/sdk";
import { QualityBadge } from "./QualityBadge";
import { useVoice } from "../store";
import { renderWithProviders } from "../../test/render";

const limits = (kbps: number) => ({ audio_bitrate_kbps: kbps, screenshare: { enabled: true, max_resolution: "1080p", max_fps: 30 }, camera: { enabled: true, max_resolution: "720p", max_fps: 30 }, stream_max_height: 0, stream_max_fps: 0, camera_max_height: 0 }) as VoiceLimits;

describe("QualityBadge (the voice panel's quality label)", () => {
  afterEach(() => useVoice.setState({ limits: null }));

  it("names the preset of the call and gives the bitrate in the tooltip", () => {
    useVoice.setState({ limits: limits(64) });
    renderWithProviders(<QualityBadge />);
    const badge = screen.getByTestId("voice-quality");
    expect(badge).toHaveTextContent("Hoch");
    expect(badge).toHaveAttribute("title", "Sprachqualität: Hoch, Opus 64 kbit/s");
    expect(badge).toHaveAttribute("data-kbps", "64");
  });

  it("shows music mode with its traffic and custom values with their bitrate", () => {
    useVoice.setState({ limits: limits(192) });
    const { unmount } = renderWithProviders(<QualityBadge />);
    expect(screen.getByTestId("voice-quality")).toHaveTextContent("Musik");
    expect(screen.getByTestId("voice-quality").getAttribute("title")).toBe("Sprachqualität: Musik, Opus 192 kbit/s, Stereo, etwa 86 MB pro Stunde");
    unmount();
    useVoice.setState({ limits: limits(96) });
    renderWithProviders(<QualityBadge />);
    expect(screen.getByTestId("voice-quality")).toHaveTextContent("96 kbit/s");
  });

  it("is hidden before the join", () => {
    renderWithProviders(<QualityBadge />);
    expect(screen.queryByTestId("voice-quality")).toBeNull();
  });
});
