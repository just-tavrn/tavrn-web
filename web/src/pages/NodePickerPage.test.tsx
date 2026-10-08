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

describe("NodePickerPage: address first (FEDERATION.md §1.4, resolved by the shell)", () => {
  function withResolver(initial: string | null = null) {
    let node = initial;
    const set = vi.fn(async (url: string) => {
      node = url;
    });
    const resolve = vi.fn(async (domain: string) => {
      if (domain === "nowhere.example") throw { code: "resolve.unreachable", step: "srv", domain };
      if (domain === "bad.example") throw { code: "resolve.invalid", step: "well_known", domain };
      return { domain, api: `https://app.${domain}/api/v1`, ws: `wss://app.${domain}/api/v1/ws`, web: `https://app.${domain}`, source: "srv" as const };
    });
    setPlatform({
      kind: "desktop",
      isDesktop: true,
      nodeBase: () => node ?? "",
      webOrigin: () => node ?? location.origin,
      openExternal: async () => {},
      appVersion: async () => "0.2.0",
      node: { current: () => node, set, resolve, domain: () => null },
    });
    return { set, resolve };
  }

  async function submitAddress(value: string) {
    const u = userEvent.setup();
    const input = screen.getByLabelText("Deine Adresse");
    await u.clear(input);
    await u.type(input, value);
    await u.click(screen.getByRole("button", { name: "Verbinden" }));
  }

  it("finds the node of an address, keeps its domain and endpoints and continues with the username", async () => {
    const { set, resolve } = withResolver();
    renderWithProviders(<NodePickerPage />);
    await submitAddress("Alice@Home.Example");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/login?username=alice"));
    expect(resolve).toHaveBeenCalledWith("home.example");
    expect(set).toHaveBeenCalledWith("https://app.home.example", { domain: "home.example", web: "https://app.home.example" });
  });

  it("a domain alone continues to the login page", async () => {
    withResolver();
    renderWithProviders(<NodePickerPage />);
    await submitAddress("home.example");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/login"));
  });

  it("says what failed at which step", async () => {
    const { set } = withResolver();
    renderWithProviders(<NodePickerPage />);
    await submitAddress("alice@nowhere.example");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("nowhere.example ist nicht erreichbar");
    expect(screen.getByTestId("node-picker-error")).toHaveTextContent("_tavrn._tcp.nowhere.example");
    await submitAddress("bad.example");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("ungültig");
    await submitAddress("not an address");
    expect(await screen.findByTestId("node-picker-error")).toHaveTextContent("alice@tavrn.example");
    expect(set).not.toHaveBeenCalled();
  });

  it("keeps the node URL as the advanced way (development nodes)", async () => {
    const { set } = withResolver();
    mockFetch({ "/.well-known/tavrn": { body: { domain: "localhost", web: "http://127.0.0.1:8300" } } });
    renderWithProviders(<NodePickerPage />);
    expect(screen.queryByLabelText("Adresse des Knotens")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Erweitert: Knoten-URL" }));
    await submit("http://127.0.0.1:8300");
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith("http://127.0.0.1:8300", { domain: "localhost", web: "http://127.0.0.1:8300" }));
  });

  it("changing the node by address signs out of the old one first", async () => {
    withResolver("https://old.example");
    useAuth.getState().setSession({ status: "ok", user, access_token: "acc", refresh_token: "ref", expires_in: 3600, device_id: "d1", recovery_code_used: false } as never);
    renderWithProviders(<NodePickerPage />);
    await submitAddress("alice@home.example");
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith("/login?username=alice"));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
