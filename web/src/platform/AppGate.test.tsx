// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { UserSettingsPage } from "../pages/UserSettingsPage";
import { resetPlatform, setPlatform } from "./index";
import type { Platform } from "./types";
import { mockFetch, renderWithProviders } from "../test/render";
import { Route, Routes } from "react-router";

const desktop = (node: string | null): Platform => ({
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => node ?? "",
  webOrigin: () => node ?? location.origin,
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
  node: { current: () => node, set: async () => {} },
});

function renderApp(path: string) {
  window.history.pushState({}, "", path);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resetPlatform();
  window.history.pushState({}, "", "/");
});

describe("the desktop app's node gate", () => {
  it("shows the node picker for every path until a node is chosen", async () => {
    setPlatform(desktop(null));
    mockFetch({});
    renderApp("/rooms/abc/channels/def");
    expect(await screen.findByRole("heading", { name: "Wähle deinen Heimatknoten" })).toBeInTheDocument();
  });

  it("offers the picker at /node once a node is chosen", async () => {
    setPlatform(desktop("https://tavrn.example"));
    mockFetch({});
    renderApp("/node");
    expect(await screen.findByTestId("node-picker-current")).toHaveTextContent("https://tavrn.example");
  });

  it("has no node picker in the browser", async () => {
    mockFetch({});
    renderApp("/node");
    expect(screen.queryByRole("heading", { name: "Wähle deinen Heimatknoten" })).toBeNull();
  });
});

describe("Settings → App", () => {
  const settings = () =>
    renderWithProviders(
      <Routes>
        <Route path="/settings/:tab?" element={<UserSettingsPage />} />
      </Routes>,
      { route: "/settings/app" },
    );

  it("is a tab of the desktop app", async () => {
    setPlatform(desktop("https://tavrn.example"));
    mockFetch({});
    settings();
    expect(screen.getByRole("link", { name: "App" })).toHaveAttribute("href", "/settings/app");
    expect(await screen.findByTestId("app-node")).toHaveTextContent("https://tavrn.example");
  });

  it("does not exist in the browser", () => {
    mockFetch({});
    settings();
    expect(screen.queryByRole("link", { name: "App" })).toBeNull();
    expect(screen.queryByTestId("app-node")).toBeNull();
  });
});
