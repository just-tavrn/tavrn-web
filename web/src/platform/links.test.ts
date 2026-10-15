// SPDX-License-Identifier: Apache-2.0
// Modifier clicks and middle clicks on the client's own links inside the apps (desktop Tauri, Electron, Android): there
// is no tab to open, so they navigate in place like a plain click instead of asking the shell for a new window (which
// opened the app's own route, e.g. https://tauri.localhost/settings/voice, in the system browser).
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLinkHandler } from "./links";
import { initPlatform, resetPlatform } from "./index";

const anchor = (href: string, target?: string) => {
  const a = document.createElement("a");
  a.href = href;
  if (target) a.target = target;
  a.textContent = "link";
  document.body.appendChild(a);
  return a;
};

/** What a router link does with a plain click: navigates in the client (recorded) and prevents the default. */
const routerLink = (href: string) => {
  const a = anchor(href);
  const plain: string[] = [];
  const seen: MouseEvent[] = [];
  a.addEventListener("click", (e) => {
    seen.push(e);
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    plain.push(new URL(a.href).pathname);
  });
  return { a, plain, seen };
};

const fire = (a: Element, type: "click" | "auxclick", init: MouseEventInit) => {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  a.dispatchEvent(ev);
  return ev;
};

/**
 * Whether the event still reaches the browser's default action (a new tab or window, a download): the handlers under
 * test let it through. It is stopped right after, at the window: the test environment cannot open tabs.
 */
const reachesDefault = (a: Element, type: "click" | "auxclick", init: MouseEventInit) => {
  let reached = false;
  const record = (e: Event) => {
    reached = !e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener(type, record);
  fire(a, type, init);
  window.removeEventListener(type, record);
  return reached;
};

let removers: Array<() => void> = [];
const install = (open = vi.fn(async (_url: string) => {})) => {
  removers.push(installLinkHandler(document, open, () => "https://tavrn.example"));
  return open;
};

afterEach(() => {
  for (const r of removers) r();
  removers = [];
  document.body.innerHTML = "";
  resetPlatform();
});

describe("modifier clicks on the app's own links inside a shell", () => {
  for (const [name, init] of [
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
  ] as const) {
    it(`a ${name}-click navigates in place and never asks for a new window`, () => {
      const open = install();
      const link = routerLink(`${location.origin}/settings/voice`);
      const ev = fire(link.a, "click", { button: 0, ...init });
      expect(ev.defaultPrevented).toBe(true);
      expect(link.plain).toEqual(["/settings/voice"]);
      // The link's own handlers see only the plain click (a drawer closes once, not twice).
      expect(link.seen).toHaveLength(1);
      expect(open).not.toHaveBeenCalled();
    });
  }

  it("a middle click navigates in place too", () => {
    const open = install();
    const link = routerLink(`${location.origin}/rooms/1`);
    const ev = fire(link.a, "auxclick", { button: 1 });
    expect(ev.defaultPrevented).toBe(true);
    expect(link.plain).toEqual(["/rooms/1"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("a relative link is the app's own link", () => {
    install();
    const link = routerLink("/settings");
    fire(link.a, "click", { button: 0, ctrlKey: true });
    expect(link.plain).toEqual(["/settings"]);
  });

  it("a modifier or middle click on a page meant for a new tab opens it on the node's web client, like a plain click", () => {
    const open = install();
    const a = anchor(`${location.origin}/legal/terms`, "_blank");
    expect(fire(a, "auxclick", { button: 1 }).defaultPrevented).toBe(true);
    expect(fire(a, "click", { button: 0, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(open.mock.calls).toEqual([["https://tavrn.example/legal/terms"], ["https://tavrn.example/legal/terms"]]);
  });

  it("leaves the right button, downloads and blob links alone", () => {
    install();
    const link = routerLink(`${location.origin}/rooms/1`);
    expect(reachesDefault(link.a, "auxclick", { button: 2 })).toBe(true);
    const dl = anchor(`${location.origin}/files/1`);
    dl.download = "file.txt";
    expect(reachesDefault(dl, "click", { button: 0, ctrlKey: true })).toBe(true);
    const blob = anchor("blob:https://tavrn.example/abc");
    expect(reachesDefault(blob, "auxclick", { button: 1 })).toBe(true);
    expect(link.plain).toEqual([]);
  });

  it("leaves links to other sites to the external-link handling", () => {
    const open = install();
    const ext = anchor("https://example.org/page");
    // A Ctrl-click opens the system browser as a plain click does; a middle click is the shell's new-window request,
    // which hands web links to the system browser.
    expect(fire(ext, "click", { button: 0, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(reachesDefault(ext, "auxclick", { button: 1 })).toBe(true);
    expect(open.mock.calls).toEqual([["https://example.org/page"]]);
  });

  it("stops after the uninstaller ran", () => {
    removers.push(installLinkHandler(document, vi.fn(async () => {}), () => "https://tavrn.example"));
    for (const r of removers) r();
    removers = [];
    const link = routerLink(`${location.origin}/rooms/1`);
    expect(reachesDefault(link.a, "click", { button: 0, ctrlKey: true })).toBe(true);
    expect(link.plain).toEqual([]);
  });
});

describe("in the plain browser", () => {
  it("keeps the default: a Ctrl-click or a middle click still opens a tab", async () => {
    await initPlatform(() => false, vi.fn(), { detect: () => false, load: vi.fn() });
    const link = routerLink(`${location.origin}/settings/voice`);
    expect(reachesDefault(link.a, "click", { button: 0, ctrlKey: true })).toBe(true);
    expect(reachesDefault(link.a, "auxclick", { button: 1 })).toBe(true);
    expect(link.plain).toEqual([]);
  });
});
