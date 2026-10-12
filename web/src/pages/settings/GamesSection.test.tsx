// SPDX-License-Identifier: Apache-2.0
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPlatform, setPlatform } from "../../platform";
import type { Platform } from "../../platform";
import { renderWithProviders } from "../../test/render";
import { KNOWN_GAMES } from "../../games/known";
import { parseGames, useGames, useGameSupport } from "../../games/store";
import { usePresence } from "../../stores/presence";
import type { MyPresence } from "@tavrn/sdk";
import { GamesSection } from "./GamesSection";

function desktop(games = true) {
  const p: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => "https://tavrn.example",
    webOrigin: () => "https://tavrn.example",
    openExternal: async () => {},
    appVersion: async () => "0.4.0",
    ...(games ? { games: { watch: async () => true, onGame: () => () => {} } } : {}),
  };
  setPlatform(p);
}

beforeEach(() => {
  localStorage.clear();
  useGames.setState(parseGames(null));
  useGameSupport.setState({ supported: null });
  usePresence.getState().clear();
});
afterEach(() => resetPlatform());

describe("Settings → App → Game activity", () => {
  it("is off by default, shows the whole watched list and the privacy rules", async () => {
    desktop();
    renderWithProviders(<GamesSection />);
    const toggle = screen.getByRole("checkbox", { name: /Das Spiel anzeigen, das ich spiele/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/nie Fenstertitel oder andere Programme/)).toBeInTheDocument();
    const list = screen.getByTestId("games-list");
    expect(within(list).getByText(`Beobachtete Spiele (${KNOWN_GAMES.length})`)).toBeInTheDocument();
    expect(within(list).getByText("eldenring.exe")).toBeInTheDocument();
    await userEvent.setup().click(toggle);
    expect(useGames.getState().enabled).toBe(true);
  });

  it("switches a built-in game off and adds and removes an own one", async () => {
    desktop();
    renderWithProviders(<GamesSection />);
    const user = userEvent.setup();
    await user.click(screen.getByText(`Beobachtete Spiele (${KNOWN_GAMES.length})`));
    await user.click(screen.getByRole("checkbox", { name: /ELDEN RING/ }));
    expect(useGames.getState().off).toEqual(["eldenring.exe"]);
    await user.type(screen.getByLabelText("Prozessname"), "C:\\x.exe");
    await user.type(screen.getByLabelText("Angezeigt als"), "X");
    await user.click(screen.getByTestId("games-add"));
    expect(screen.getByRole("alert")).toHaveTextContent("kein Ordner");
    await user.clear(screen.getByLabelText("Prozessname"));
    await user.type(screen.getByLabelText("Prozessname"), "mygame.exe");
    await user.click(screen.getByTestId("games-add"));
    expect(within(screen.getByTestId("games-own")).getByText("mygame.exe")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "X entfernen" }));
    expect(screen.queryByTestId("games-own")).toBeNull();
  });

  it("says when the system cannot tell or the activity is hidden; absent outside the desktop app", async () => {
    desktop();
    useGames.getState().setEnabled(true);
    renderWithProviders(<GamesSection />);
    act(() => useGameSupport.setState({ supported: false }));
    expect(screen.getByTestId("games-unavailable")).toBeInTheDocument();
    act(() => usePresence.getState().setMine({ hide_activity: true } as MyPresence));
    expect(screen.getByTestId("games-hidden")).toHaveTextContent("Du verbirgst deine Aktivität");
    resetPlatform();
    desktop(false);
    const { container } = renderWithProviders(<GamesSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
