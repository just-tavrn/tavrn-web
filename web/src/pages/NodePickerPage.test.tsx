// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodePickerPage, nodePickerDeps } from "./NodePickerPage";
import { resetPlatform, setPlatform } from "../platform";
import type { Platform } from "../platform";
import { useAuth } from "../stores/auth";
import { useNodes } from "../stores/nodes";
import { mockFetch, renderWithProviders } from "../test/render";

const user = { id: "u1", username: "alice", domain: "old.example", address: "alice@old.example", display_name: "Alice", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

function desktop(initial: string | null, refuse = false) {
  let node = initial;
  const set = vi.fn(async (url: string) => {
    if (refuse) throw "node_url.insecure";
    node = url;
  });
  const p: Platform = {
    kind: "desktop",
    isDesktop: true,
    nodeBase: () => node ?? "",
    webOrigin: () => node ?? location.origin,
    openExternal: async () => {},
    appVersion: async () => "0.2.0",
    node: { current: () => node, set },
  };
  setPlatform(p);
  return set;
}

const reload = vi.fn();
const signOut = vi.fn(async () => {
  useAuth.getState().logout();
  useNodes.getState().clear();
});
const wellKnown = { "/.well-known/tavrn": { body: { domain: "tavrn.example" } } };

beforeEach(() => {
  reload.mockReset();
  signOut.mockClear();
  nodePickerDeps.reload = reload;
  nodePickerDeps.signOut = signOut;
  useAuth.getState().logout();
});

afterEach(() => resetPlatform());

async function submit(value: string) {
  const u = userEvent.setup();
  const input = screen.getByLabelText("Adresse des Knotens");
  await u.clear(input);
  await u.type(input, value);
  await u.click(screen.getByRole("button", { name: "Verbinden" }));
}

describe("NodePickerPage", () => {
  it("asks for the home node on the first start", async () => {
    desktop(null);
    renderWithProviders(<NodePickerPage />);
    expect(screen.getByRole("heading", { name: "Wähle deinen Heimatknoten" })).toBeInTheDocument();
    expect(screen.queryByTestId("node-picker-current")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abbrechen" })).toBeNull();
  });

  it("refuses plain http to other hosts without calling anything", async () => {
    const set = desktop(null);
    const calls = mockFetch(wellKnown);
    renderWithProviders(<NodePickerPage />);
    await submit("http://evil");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("https");
    expect(calls).toHaveLength(0);
    expect(set).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Adresse des Knotens")).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses paths and credentials", async () => {
    desktop(null);
    mockFetch(wellKnown);
    renderWithProviders(<NodePickerPage />);
    await submit("https://tavrn.example/app");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("ohne Pfad");
    await submit("https://me:pw@tavrn.example");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("Benutzername");
  });

  it("reports a server that is not a tavrn node", async () => {
    const set = desktop(null);
    mockFetch({ "/.well-known/tavrn": { status: 404, body: {} } });
    renderWithProviders(<NodePickerPage />);
    await submit("https://example.org");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("Kein tavrn-Knoten");
    expect(set).not.toHaveBeenCalled();
  });

  it("reports an unreachable node", async () => {
    desktop(null);
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    renderWithProviders(<NodePickerPage />);
    await submit("https://down.example");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("nicht erreichbar");
  });

  it("checks the node, persists it through the shell and continues to the login", async () => {
    const set = desktop(null);
    const calls = mockFetch(wellKnown);
    renderWithProviders(<NodePickerPage />);
    await submit("tavrn.example");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/login"));
    expect(calls[0]?.url).toBe("https://tavrn.example/.well-known/tavrn");
    expect(set).toHaveBeenCalledWith("https://tavrn.example");
  });

  it("accepts a development node on this computer", async () => {
    const set = desktop(null);
    mockFetch({ "/.well-known/tavrn": { body: { domain: "localhost" } } });
    renderWithProviders(<NodePickerPage />);
    await submit("http://127.0.0.1:8300");
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith("http://127.0.0.1:8300"));
  });

  it("shows the shell's refusal", async () => {
    desktop(null, true);
    mockFetch(wellKnown);
    renderWithProviders(<NodePickerPage />);
    await submit("https://tavrn.example");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("abgelehnt");
    expect(reload).not.toHaveBeenCalled();
  });

  it("changing the node signs out of the old one", async () => {
    desktop("https://old.example");
    mockFetch(wellKnown);
    useAuth.getState().setSession({ status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "d1", recovery_code_used: false } as never);
    useNodes.getState().put({ domain: "x.example", base: "https://x.example", ws: "wss://x.example/api/v1/ws", web: "https://x.example", token: "t", refresh: "r", deviceId: "d1", user: user as never, expiresAt: Date.now() + 1000 });
    renderWithProviders(<NodePickerPage />);
    expect(screen.getByTestId("node-picker-current")).toHaveTextContent("https://old.example");
    expect(screen.getByTestId("node-picker-warning")).toBeInTheDocument();
    expect(screen.getByLabelText("Adresse des Knotens")).toHaveValue("https://old.example");
    await submit("https://tavrn.example");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/login"));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuth.getState().token).toBeNull();
    expect(useNodes.getState().sessions).toEqual({});
  });

  it("keeps the session when the same node is confirmed again", async () => {
    desktop("https://tavrn.example");
    mockFetch(wellKnown);
    useAuth.getState().setSession({ status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "d1", recovery_code_used: false } as never);
    renderWithProviders(<NodePickerPage />);
    await submit("https://tavrn.example/");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/"));
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuth.getState().token).toBe("acc");
  });
});
