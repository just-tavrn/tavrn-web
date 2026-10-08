// SPDX-License-Identifier: Apache-2.0
/**
 * The API base plumbing: everything that used to take the origin the client was loaded from follows the
 * platform, so the desktop app talks to the node the user picked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { publicApi, homeBase, wsUrl } from "../lib/api";
import { homeWeb, useAuth } from "../stores/auth";
import { nodeDeps } from "../stores/nodes";
import { resetPlatform, setPlatform } from "./index";
import type { Platform } from "./types";
import { mockFetch } from "../test/render";

const desktop = (node: string): Platform => ({
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => node,
  webOrigin: () => node,
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
  node: { current: () => node, set: async () => {} },
});

afterEach(() => {
  resetPlatform();
  useAuth.setState({ home: null });
});

describe("API base plumbing", () => {
  it("browser: the API, the WebSocket and links stay on this origin", () => {
    expect(publicApi.baseUrl).toBe("");
    expect(homeBase()).toBe("");
    expect(wsUrl()).toBe(`${location.origin.replace(/^http/, "ws")}/api/v1/ws`);
    expect(homeWeb()).toBe(location.origin);
  });

  it("desktop: the API, the WebSocket and links go to the chosen node", () => {
    setPlatform(desktop("https://tavrn.example"));
    expect(publicApi.baseUrl).toBe("https://tavrn.example");
    expect(homeBase()).toBe("https://tavrn.example");
    expect(wsUrl()).toBe("wss://tavrn.example/api/v1/ws");
    expect(homeWeb()).toBe("https://tavrn.example");
  });

  it("desktop: a home node of another account still wins over the chosen node", () => {
    setPlatform(desktop("https://tavrn.example"));
    useAuth.setState({ home: { domain: "other.example", base: "https://api.other.example", ws: "wss://api.other.example/api/v1/ws", web: "https://other.example" } });
    expect(homeBase()).toBe("https://api.other.example");
    expect(wsUrl()).toBe("wss://api.other.example/api/v1/ws");
    expect(homeWeb()).toBe("https://other.example");
  });

  it("desktop: the chosen node's own domain is reached at the chosen URL", async () => {
    setPlatform(desktop("https://chat.tavrn.example"));
    const calls = mockFetch({ "/.well-known/tavrn": { body: { domain: "tavrn.example" } } });
    await expect(nodeDeps.discover("tavrn.example")).resolves.toEqual({
      domain: "tavrn.example",
      base: "https://chat.tavrn.example",
      ws: "wss://chat.tavrn.example/api/v1/ws",
      web: "https://chat.tavrn.example",
    });
    expect(calls[0]?.url).toBe("https://chat.tavrn.example/.well-known/tavrn");
  });
});
