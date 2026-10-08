// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { createTauriPlatform, installLinkHandler } from "./tauri";
import type { HotkeyEvent } from "./types";
import { detectTauri } from "./tauriDetect";

const detached = () => document.implementation.createHTMLDocument("app");

type Calls = Array<{ cmd: string; args: unknown }>;

function backend(state: { node: string | null; web?: string | null; domain?: string | null; updater?: boolean; update?: unknown; channel?: Channel<HotkeyEvent> }): Calls {
  const calls: Calls = [];
  mockWindows("main");
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "get_config":
        return { node: state.node, web: state.web ?? null, domain: state.domain ?? null };
      case "app_info":
        return { version: "0.2.0", updater: state.updater ?? false };
      case "set_node": {
        const url = (args as { url: string }).url;
        if (!url.startsWith("https://")) throw "node_url.insecure";
        state.node = url.replace(/\/$/, "");
        return state.node;
      }
      case "open_external":
      case "install_update":
      case "open_connect":
      case "close_connect":
        return null;
      case "resolve_node":
        if ((args as { domain: string }).domain === "nowhere.example") throw { code: "resolve.not_found", step: "direct", domain: "nowhere.example" };
        return { domain: "home.example", api: "https://app.home.example/api/v1", ws: "wss://app.home.example/api/v1/ws", web: "https://app.home.example", source: "well_known" };
      case "check_update":
        return state.update ?? null;
      case "listen_hotkeys":
        state.channel = (args as { onEvent: Channel<HotkeyEvent> }).onEvent;
        return null;
      case "register_hotkey": {
        const { combo } = args as { combo: string };
        if (combo === "KeyM") throw "hotkey.typing_key";
        return combo.replace("control", "Ctrl");
      }
      case "unregister_hotkey":
        return null;
    }
    throw `unknown command ${cmd}`;
  });
  return calls;
}

beforeEach(() => {
  (window as unknown as { isTauri?: boolean }).isTauri = true;
});

afterEach(() => {
  clearMocks();
  delete (window as unknown as { isTauri?: boolean }).isTauri;
});

describe("detectTauri", () => {
  it("detects the Tauri runtime, never the user agent", () => {
    expect(detectTauri()).toBe(true);
    delete (window as unknown as { isTauri?: boolean }).isTauri;
    expect(detectTauri()).toBe(false);
  });

  it("only in the main window: the node's page in the sign-in window is a plain web client", () => {
    mockWindows("main");
    expect(detectTauri()).toBe(true);
    mockWindows("connect");
    expect(detectTauri()).toBe(false);
  });
});

describe("the desktop app's node and sign-in handoff", () => {
  it("keeps the identity domain and the web origin of a delegated node", async () => {
    backend({ node: "https://app.home.example", web: "https://web.home.example", domain: "home.example" });
    const p = await createTauriPlatform(detached());
    expect(p.nodeBase()).toBe("https://app.home.example");
    expect(p.webOrigin()).toBe("https://web.home.example");
    expect(p.node?.domain?.()).toBe("home.example");
  });

  it("resolves an identity domain in the shell and stores endpoints and domain", async () => {
    const calls = backend({ node: null });
    const p = await createTauriPlatform(detached());
    const found = await p.node!.resolve!("home.example");
    expect(found).toMatchObject({ domain: "home.example", api: "https://app.home.example/api/v1", web: "https://app.home.example" });
    await p.node!.set("https://app.home.example", { domain: "home.example", web: "https://app.home.example" });
    expect(calls.find((c) => c.cmd === "set_node")?.args).toEqual({ url: "https://app.home.example", web: "https://app.home.example", domain: "home.example" });
    expect(p.webOrigin()).toBe("https://app.home.example");
    expect(p.node?.domain?.()).toBe("home.example");
    await expect(p.node!.resolve!("nowhere.example")).rejects.toMatchObject({ code: "resolve.not_found", step: "direct" });
  });

  it("signs in on the node's page in the shell's window and closes it afterwards", async () => {
    const calls = backend({ node: "https://home.example" });
    const p = await createTauriPlatform(detached());
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/auth/connect/session")) return json({ session_id: "S".repeat(43), expires_in: 600 });
      if (url.includes("/auth/connect/session/")) return json({ status: "ready", code: "c", node: "home.example", expires_in: 100 });
      return json({ status: "ok", access_token: "a", refresh_token: "r", device_id: "D", user: {} });
    }) as typeof fetch;
    const { TavrnApi } = await import("@tavrn/sdk");
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    const session = await p.auth!.signInOnNodePage({
      api: new TavrnApi({ baseUrl: "https://home.example", fetchImpl }),
      endpoints: { domain: "home.example", base: "https://home.example", ws: "wss://home.example/api/v1/ws", web: "https://home.example" },
      next: "/",
      mode: "register",
    });
    vi.useRealTimers();
    expect(session).toMatchObject({ access_token: "a" });
    const open = calls.find((c) => c.cmd === "open_connect")?.args as { url: string };
    expect(open.url).toMatch(/^https:\/\/home\.example\/connect\?session=S{43}&state=[A-Za-z0-9_-]+&mode=register$/);
    expect(calls.map((c) => c.cmd)).toContain("close_connect");
    await p.auth!.reopen!(open.url);
    expect(calls.filter((c) => c.cmd === "open_connect")).toHaveLength(2);
  });
});

describe("createTauriPlatform", () => {
  it("reads the chosen node and the app version from the shell", async () => {
    const calls = backend({ node: "https://tavrn.example" });
    const p = await createTauriPlatform(detached());
    expect(p.kind).toBe("desktop");
    expect(p.isDesktop).toBe(true);
    expect(p.nodeBase()).toBe("https://tavrn.example");
    expect(p.webOrigin()).toBe("https://tavrn.example");
    expect(p.node?.current()).toBe("https://tavrn.example");
    await expect(p.appVersion()).resolves.toBe("0.2.0");
    expect(calls.map((c) => c.cmd).sort()).toEqual(["app_info", "get_config", "listen_hotkeys"]);
  });

  it("has no node before the first start's choice", async () => {
    backend({ node: null });
    const p = await createTauriPlatform(detached());
    expect(p.node?.current()).toBeNull();
    expect(p.nodeBase()).toBe("");
  });

  it("persists a new node through the shell and uses its normalized value", async () => {
    const calls = backend({ node: null });
    const p = await createTauriPlatform(detached());
    await p.node?.set("https://tavrn.example/");
    expect(calls.find((c) => c.cmd === "set_node")?.args).toEqual({ url: "https://tavrn.example/" });
    expect(p.nodeBase()).toBe("https://tavrn.example");
  });

  it("keeps the old node when the shell refuses the new one", async () => {
    backend({ node: "https://tavrn.example" });
    const p = await createTauriPlatform(detached());
    await expect(p.node?.set("http://evil")).rejects.toBeDefined();
    expect(p.nodeBase()).toBe("https://tavrn.example");
  });

  it("opens external links through the shell, only http(s) and mailto", async () => {
    const calls = backend({ node: "https://tavrn.example" });
    const p = await createTauriPlatform(detached());
    await p.openExternal("https://example.org/x");
    expect(calls.find((c) => c.cmd === "open_external")?.args).toEqual({ url: "https://example.org/x" });
    await expect(p.openExternal("file:///etc/passwd")).rejects.toThrow();
    expect(calls.filter((c) => c.cmd === "open_external")).toHaveLength(1);
  });

  it("offers the updater only when the shell has an updater key", async () => {
    backend({ node: "https://tavrn.example", updater: false });
    expect((await createTauriPlatform(detached())).updater).toBeUndefined();
    clearMocks();
    const calls = backend({ node: "https://tavrn.example", updater: true, update: { version: "0.3.0", notes: "New things" } });
    const p = await createTauriPlatform(detached());
    const update = await p.updater?.check();
    expect(update).toMatchObject({ version: "0.3.0", notes: "New things" });
    await update?.install();
    expect(calls.map((c) => c.cmd)).toContain("install_update");
  });

  it("reports no update when the shell finds none", async () => {
    backend({ node: "https://tavrn.example", updater: true, update: null });
    const p = await createTauriPlatform(detached());
    await expect(p.updater?.check()).resolves.toBeNull();
  });
});

describe("global hotkeys (platform.hotkeys)", () => {
  it("registers and unregisters bindings through the shell, which canonicalizes or refuses them", async () => {
    const calls = backend({ node: "https://tavrn.example" });
    const p = await createTauriPlatform(detached());
    await expect(p.hotkeys?.register("toggle_mute", "control+Shift+KeyM")).resolves.toBe("Ctrl+Shift+KeyM");
    expect(calls.find((c) => c.cmd === "register_hotkey")?.args).toEqual({ action: "toggle_mute", combo: "control+Shift+KeyM" });
    await expect(p.hotkeys?.register("push_to_talk", "KeyM")).rejects.toBe("hotkey.typing_key");
    await p.hotkeys?.unregister("toggle_mute");
    expect(calls.find((c) => c.cmd === "unregister_hotkey")?.args).toEqual({ action: "toggle_mute" });
  });

  it("hands the shell's presses and releases to every subscriber until it unsubscribes", async () => {
    const state: Parameters<typeof backend>[0] = { node: "https://tavrn.example" };
    backend(state);
    const p = await createTauriPlatform(detached());
    expect(state.channel).toBeDefined();
    const seen: HotkeyEvent[] = [];
    const other = vi.fn();
    const off = p.hotkeys!.subscribe((e) => seen.push(e));
    p.hotkeys!.subscribe(other);
    state.channel!.onmessage({ action: "push_to_talk", pressed: true });
    state.channel!.onmessage({ action: "push_to_talk", pressed: false });
    off();
    state.channel!.onmessage({ action: "toggle_deafen", pressed: true });
    expect(seen).toEqual([
      { action: "push_to_talk", pressed: true },
      { action: "push_to_talk", pressed: false },
    ]);
    expect(other).toHaveBeenCalledTimes(3);
  });

  it("the browser has no global hotkeys", async () => {
    const { browserPlatform } = await import("./browser");
    expect(browserPlatform.hotkeys).toBeUndefined();
  });
});

describe("installLinkHandler", () => {
  const click = (a: HTMLAnchorElement) => {
    document.body.appendChild(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    a.remove();
    return ev.defaultPrevented;
  };
  const anchor = (href: string, target?: string) => {
    const a = document.createElement("a");
    a.href = href;
    if (target) a.target = target;
    a.textContent = "link";
    return a;
  };

  it("opens links to other sites in the system browser", () => {
    const open = vi.fn(async () => {});
    const remove = installLinkHandler(document, open, () => "https://tavrn.example");
    expect(click(anchor("https://example.org/page"))).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.org/page");
    remove();
  });

  it("opens the app's own pages meant for a new tab on the node's web client", () => {
    const open = vi.fn(async () => {});
    const remove = installLinkHandler(document, open, () => "https://tavrn.example");
    expect(click(anchor(`${location.origin}/legal/terms?x=1#a`, "_blank"))).toBe(true);
    expect(open).toHaveBeenCalledWith("https://tavrn.example/legal/terms?x=1#a");
    remove();
  });

  it("leaves in-app navigation alone", () => {
    const open = vi.fn(async () => {});
    const remove = installLinkHandler(document, open, () => "https://tavrn.example");
    const a = anchor(`${location.origin}/rooms/1`);
    a.addEventListener("click", (e) => e.preventDefault());
    click(a);
    expect(open).not.toHaveBeenCalled();
    remove();
  });

  it("ignores downloads and blob links", () => {
    const open = vi.fn(async () => {});
    const remove = installLinkHandler(document, open, () => "https://tavrn.example");
    const dl = anchor("blob:https://tavrn.example/abc");
    dl.download = "file.txt";
    dl.addEventListener("click", (e) => e.preventDefault());
    click(dl);
    expect(open).not.toHaveBeenCalled();
    remove();
  });
});
