// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsInsecureNodes, apiBase, initPlatform, originHost, originUrl, originWsUrl, platform, resetPlatform, setPlatform, webOrigin } from "./index";
import { browserPlatform } from "./browser";
import type { Platform } from "./types";

const desktop = (node: string | null): Platform => ({
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => node ?? "",
  webOrigin: () => node ?? location.origin,
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
  node: { current: () => node, set: async () => {} },
});

afterEach(() => resetPlatform());

describe("platform", () => {
  it("is the browser by default: the node is the origin the client was loaded from", () => {
    expect(platform()).toBe(browserPlatform);
    expect(platform().isDesktop).toBe(false);
    expect(apiBase()).toBe("");
    expect(originUrl()).toBe(location.origin);
    expect(originWsUrl()).toBe(`${location.origin.replace(/^http/, "ws")}/api/v1/ws`);
    expect(webOrigin()).toBe(location.origin);
    expect(originHost()).toBe(location.host);
    expect(allowsInsecureNodes()).toBe(location.protocol === "http:");
  });

  it("stays the browser when no Tauri runtime is detected and never loads the Tauri module", async () => {
    const load = vi.fn();
    await expect(initPlatform(() => false, load)).resolves.toBe(browserPlatform);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads the Tauri implementation when the runtime is detected", async () => {
    const app = desktop("https://tavrn.example");
    const load = vi.fn(async () => ({ createTauriPlatform: async () => app }));
    await expect(initPlatform(() => true, load)).resolves.toBe(app);
    expect(platform()).toBe(app);
  });

  it("derives every node URL from the chosen node in the desktop app", () => {
    setPlatform(desktop("https://tavrn.example:8443"));
    expect(apiBase()).toBe("https://tavrn.example:8443");
    expect(originUrl()).toBe("https://tavrn.example:8443");
    expect(originWsUrl()).toBe("wss://tavrn.example:8443/api/v1/ws");
    expect(webOrigin()).toBe("https://tavrn.example:8443");
    expect(originHost()).toBe("tavrn.example:8443");
    expect(allowsInsecureNodes()).toBe(false);
  });

  it("allows plain-http peers only when the chosen node itself is a development node", () => {
    setPlatform(desktop("http://127.0.0.1:8300"));
    expect(originWsUrl()).toBe("ws://127.0.0.1:8300/api/v1/ws");
    expect(allowsInsecureNodes()).toBe(true);
  });
});
