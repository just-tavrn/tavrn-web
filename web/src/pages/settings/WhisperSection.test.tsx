// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { browserPlatform } from "../../platform/browser";
import { resetPlatform, setPlatform } from "../../platform";
import { useVoiceEngine } from "../../voice/engine";
import { WhisperSection } from "./WhisperSection";
import { renderWithProviders } from "../../test/render";
import { DEFAULT_SETTINGS, useVoiceSettings } from "../../voice/settings";
import { IDLE, useVoice } from "../../voice/store";
beforeEach(() => { useVoiceEngine.setState({ kind: "browser" }); useVoice.setState(IDLE); useVoiceSettings.setState({ settings: DEFAULT_SETTINGS }); });
it("keeps reply independent and groups scoped to their room", async () => {
  useVoice.setState({ status: "connected", target: { domain: "n", roomId: "r", channelId: "c" }, lastWhisperer: "a@n/d" });
  renderWithProviders(<WhisperSection />);
  await userEvent.type(screen.getByRole("textbox", { name: "Gruppenname" }), "Raid");
  await userEvent.click(screen.getByRole("button", { name: "Neue Flüstergruppe" }));
  const groups = useVoiceSettings.getState().settings.whisperGroups["n/r"]!;
  expect(groups).toHaveLength(1); expect(groups[0]!.name).toBe("Raid");
  fireEvent.blur(screen.getByRole("textbox", { name: /Mitglieder/ }), { target: { value: "alice@n, bob@n" } });
  expect(useVoiceSettings.getState().settings.whisperGroups["n/r"]![0]!.members).toEqual(["alice@n", "bob@n"]);
  expect(useVoice.getState().lastWhisperer).toBe("a@n/d");
  act(() => useVoice.setState({ target: { domain: "other", roomId: "r", channelId: "c" } }));
  expect(screen.queryByRole("textbox", { name: /Mitglieder/ })).toBeNull();
  expect(screen.getByTestId("whisper-reply-key")).toBeInTheDocument();
});


afterEach(() => { resetPlatform(); useVoiceEngine.setState({ kind: "browser" }); });
it("offers an explicit safe browser fallback for native voice", async () => {
  const openExternal = vi.fn(async () => undefined);
  setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, webOrigin: () => "https://n.example", openExternal });
  useVoiceEngine.setState({ kind: "native" });
  renderWithProviders(<WhisperSection />);
  expect(screen.getByText(/Browser-Sprachengine/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Browser zum Flüstern öffnen" }));
  expect(openExternal).toHaveBeenCalledWith("https://n.example/");
});
