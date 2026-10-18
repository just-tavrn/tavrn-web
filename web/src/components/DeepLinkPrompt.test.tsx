// SPDX-License-Identifier: Apache-2.0
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";
import { resetPlatform, setPlatform } from "../platform";
import type { Platform } from "../platform/types";
import { renderWithProviders } from "../test/render";
import { deepLinkDeps, DeepLinkPrompt } from "./DeepLinkPrompt";
import { nudgeAppSession } from "../platform/appSession";

vi.mock("../platform/appSession", async (original) => ({ ...(await original<typeof import("../platform/appSession")>()), nudgeAppSession: vi.fn(() => true) }));

function app(node: string | null) {
  const listeners = new Set<(url: string) => void>();
  const p: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node ?? "",
    webOrigin: () => node ?? "",
    openExternal: async () => {},
    appVersion: async () => "0.4.0",
    node: { current: () => node, set: async () => {}, domain: () => (node ? "tavrn.example" : null) },
    links: {
      subscribe: (fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
    },
  };
  setPlatform(p);
  return { emit: (url: string) => act(() => listeners.forEach((fn) => fn(url))) };
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function renderPrompt() {
  return renderWithProviders(
    <>
      <DeepLinkPrompt />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </>,
    { route: "/" },
  );
}

beforeEach(() => {
  sessionStorage.clear();
  deepLinkDeps.identity = async (host) => (host === "app.other.example" ? "other.example" : null);
});
afterEach(() => {
  resetPlatform();
  vi.mocked(nudgeAppSession).mockClear();
});

describe("DeepLinkPrompt: a link from outside never navigates by itself", () => {
  it("names the target and the link, and goes there only on Open", async () => {
    const { emit } = app("https://app.tavrn.example");
    renderPrompt();
    expect(screen.queryByTestId("deep-link-prompt")).toBeNull();
    emit("tavrn://invite/app.other.example/Code_1234");
    expect(await screen.findByRole("dialog", { name: "Diesen Link öffnen?" })).toBeInTheDocument();
    expect(screen.getByTestId("deep-link-target")).toHaveTextContent("Eine Einladung in einen Raum auf app.other.example");
    expect(screen.getByTestId("deep-link-url")).toHaveTextContent("tavrn://invite/app.other.example/Code_1234");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    // Cancel has the focus: Enter never opens a link by accident.
    expect(screen.getByTestId("deep-link-cancel")).toHaveFocus();
    await userEvent.setup().click(screen.getByRole("button", { name: "Öffnen" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/invite/Code_1234?node=other.example"));
    expect(screen.queryByTestId("deep-link-prompt")).toBeNull();
  });

  it("Cancel and Escape drop the link; a room link names the channel", async () => {
    const { emit } = app("https://app.tavrn.example");
    renderPrompt();
    const user = userEvent.setup();
    emit("tavrn://room/tavrn.example/R1/C1");
    expect(await screen.findByTestId("deep-link-target")).toHaveTextContent("Einen Kanal eines Raums auf tavrn.example");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByTestId("deep-link-prompt")).toBeNull();
    emit("tavrn://room/tavrn.example/R1");
    expect(await screen.findByTestId("deep-link-target")).toHaveTextContent("Einen Raum auf tavrn.example");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("deep-link-prompt")).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    emit("tavrn://room/tavrn.example/R1/C1");
    await user.click(await screen.findByRole("button", { name: "Öffnen" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/rooms/R1/channels/C1"));
  });

  it("ignores invalid links and only wakes the waiting sign-in for tavrn://connect", async () => {
    const { emit } = app("https://app.tavrn.example");
    renderPrompt();
    emit("tavrn://invite/localhost/Code_1234");
    emit("javascript:alert(1)");
    emit(`tavrn://connect?session=${"S".repeat(43)}&state=${"s".repeat(22)}`);
    expect(nudgeAppSession).toHaveBeenCalledWith("S".repeat(43), "s".repeat(22));
    expect(screen.queryByTestId("deep-link-prompt")).toBeNull();
  });

  it("without a home node: the node picker with the link's node, and the link again once a node is chosen", async () => {
    const { emit } = app(null);
    const { unmount } = renderPrompt();
    emit("tavrn://invite/chat.example/Code_1234");
    expect(await screen.findByTestId("deep-link-no-node")).toHaveTextContent("Wähle zuerst deinen Heimatknoten");
    await userEvent.setup().click(screen.getByRole("button", { name: "Knoten wählen" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/node?address=chat.example"));
    unmount();
    // The picker reloads the client with the chosen node: the link is offered again.
    app("https://chat.example");
    renderPrompt();
    expect(await screen.findByTestId("deep-link-url")).toHaveTextContent("tavrn://invite/chat.example/Code_1234");
    expect(screen.getByRole("button", { name: "Öffnen" })).toBeInTheDocument();
  });
});
