// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createTauriPlatform, installLinkHandler } from "./tauri";
import { detectTauri } from "./tauriDetect";

const detached = () => document.implementation.createHTMLDocument("app");

type Calls = Array<{ cmd: string; args: unknown }>;

function backend(state: { node: string | null; updater?: boolean; update?: unknown }): Calls {
  const calls: Calls = [];
  mockWindows("main");
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "get_config":
        return { node: state.node };
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
        return null;
      case "check_update":
        return state.update ?? null;
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
    expect(calls.map((c) => c.cmd).sort()).toEqual(["app_info", "get_config"]);
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
