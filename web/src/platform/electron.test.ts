// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElectronPlatform } from "./electron";
import type { BridgeEvent, ShellConfig, TavrnShellBridge } from "./electronBridge";
import { detectElectron, electronBridge } from "./electronDetect";
import { SAVE_CHUNK_BYTES } from "./files";
import type { HotkeyEvent } from "./types";

const detached = () => document.implementation.createHTMLDocument("app");
const notImplemented = (name: string) => () => Promise.reject(new Error(`not implemented: ${name}`));

/** A bridge as the preload exposes it, with the shell's answers as fakes. */
function fakeBridge(config: Partial<ShellConfig> = {}, updater = false) {
  let listener: ((e: BridgeEvent) => void) | null = null;
  const state = { node: config.node ?? null, web: config.web ?? null, domain: config.domain ?? null };
  const bridge = {
    kind: "electron",
    window: "main",
    shell: {
      getConfig: vi.fn(async () => ({ ...state })),
      setNode: vi.fn(async (url: string) => {
        if (!url.startsWith("https://")) throw "node_url.insecure";
        state.node = url.replace(/\/$/, "");
        return state.node;
      }),
      appInfo: vi.fn(async () => ({ version: "0.2.0", updater })),
      openExternal: vi.fn(async () => {}),
      resolveNode: vi.fn(async (domain: string) => {
        if (domain === "nowhere.example") throw { code: "resolve.not_found", step: "direct", domain };
        return { domain: "home.example", api: "https://app.home.example/api/v1", ws: "wss://app.home.example/api/v1/ws", web: "https://app.home.example", source: "well_known" as const };
      }),
      openConnect: vi.fn(async () => {}),
      closeConnect: vi.fn(async () => {}),
    },
    updater: { checkUpdate: vi.fn(async () => ({ version: "0.3.0", notes: "New things" })), installUpdate: vi.fn(async () => {}) },
    files: {
      saveFileBegin: vi.fn(async () => ({ status: "ready" as const, id: "s1" })),
      saveFileChunk: vi.fn(async () => {}),
      saveFileEnd: vi.fn(async () => ({ path: "/home/u/Downloads/a.bin", folder: "Downloads" })),
      saveFileAbort: vi.fn(async () => {}),
      saveFileReveal: vi.fn(async () => {}),
    },
    keychain: {
      keychainGet: vi.fn(async () => new Uint8Array(32).fill(7)),
      keychainSet: vi.fn(async () => {}),
      keychainDelete: vi.fn(async () => {}),
      keychainStatus: vi.fn(async () => ({ backend: "secret-service" as const, available: true })),
    },
    notify: { notify: vi.fn(notImplemented("notify")) },
    tray: {
      traySet: vi.fn(async () => {}),
      trayStatus: vi.fn(async () => ({ state: "connected" as const, tooltip: "tavrn", available: true, close_to_tray: true })),
      setCloseToTray: vi.fn(async () => {}),
      quitApp: vi.fn(async () => {}),
    },
    hotkeys: {
      registerHotkey: vi.fn(async (_action: string, combo: string) => {
        if (combo === "Ctrl+KeyQ+KeyM") throw "hotkey.invalid";
        return combo.replace("control", "Ctrl");
      }),
      unregisterHotkey: vi.fn(async () => {}),
      setHotkeysEnabled: vi.fn(async (enabled: boolean) => enabled),
    },
    events: {
      subscribe: vi.fn((handler: (e: BridgeEvent) => void) => {
        listener = handler;
        return () => {
          listener = null;
        };
      }),
    },
  } satisfies TavrnShellBridge;
  const emit = (e: unknown) => listener?.(e as BridgeEvent);
  return { bridge, emit };
}

afterEach(() => {
  delete (window as unknown as { tavrnShell?: unknown }).tavrnShell;
});

describe("detectElectron", () => {
  it("detects the shell's bridge in the main window, never the user agent", () => {
    expect(detectElectron()).toBe(false);
    (window as unknown as { tavrnShell: unknown }).tavrnShell = fakeBridge().bridge;
    expect(detectElectron()).toBe(true);
    expect(electronBridge()?.kind).toBe("electron");
  });

  it("refuses anything that is not the Electron shell's main window", () => {
    for (const fake of [{}, { kind: "tauri", window: "main" }, { kind: "electron", window: "connect" }, { kind: "electron" }, null, "electron"]) {
      (window as unknown as { tavrnShell: unknown }).tavrnShell = fake;
      expect(detectElectron(), JSON.stringify(fake)).toBe(false);
    }
  });
});

describe("createElectronPlatform", () => {
  it("is the desktop platform with the chosen node and the app version from the shell", async () => {
    const { bridge } = fakeBridge({ node: "https://tavrn.example" });
    const p = await createElectronPlatform(bridge, detached());
    expect(p.kind).toBe("desktop");
    expect(p.isDesktop).toBe(true);
    expect(p.nodeBase()).toBe("https://tavrn.example");
    expect(p.webOrigin()).toBe("https://tavrn.example");
    expect(p.node?.current()).toBe("https://tavrn.example");
    await expect(p.appVersion()).resolves.toBe("0.2.0");
    // Voice runs in Chromium: no native engine.
    expect(p.voice).toBeUndefined();
    expect(bridge.events.subscribe).toHaveBeenCalledTimes(1);
  });

  it("refuses to start outside the shell", async () => {
    await expect(createElectronPlatform(null, detached())).rejects.toThrow(/Electron shell/);
  });

  it("has no node before the first start's choice", async () => {
    const p = await createElectronPlatform(fakeBridge().bridge, detached());
    expect(p.node?.current()).toBeNull();
    expect(p.nodeBase()).toBe("");
  });

  it("keeps the identity domain and the web origin of a delegated node", async () => {
    const p = await createElectronPlatform(fakeBridge({ node: "https://app.home.example", web: "https://web.home.example", domain: "home.example" }).bridge, detached());
    expect(p.nodeBase()).toBe("https://app.home.example");
    expect(p.webOrigin()).toBe("https://web.home.example");
    expect(p.node?.domain?.()).toBe("home.example");
  });

  it("persists a new node through the shell and uses its normalized value", async () => {
    const { bridge } = fakeBridge();
    const p = await createElectronPlatform(bridge, detached());
    await p.node?.set("https://tavrn.example/");
    expect(bridge.shell.setNode).toHaveBeenLastCalledWith("https://tavrn.example/");
    expect(p.nodeBase()).toBe("https://tavrn.example");
    await p.node?.set("https://app.home.example", { domain: "home.example", web: "https://app.home.example/" });
    expect(bridge.shell.setNode).toHaveBeenLastCalledWith("https://app.home.example", "https://app.home.example/", "home.example");
    expect(p.webOrigin()).toBe("https://app.home.example");
    expect(p.node?.domain?.()).toBe("home.example");
  });

  it("keeps the old node when the shell refuses the new one", async () => {
    const p = await createElectronPlatform(fakeBridge({ node: "https://tavrn.example" }).bridge, detached());
    await expect(p.node?.set("http://evil")).rejects.toBe("node_url.insecure");
    expect(p.nodeBase()).toBe("https://tavrn.example");
  });

  it("resolves an identity domain in the shell, with its failures as the Tauri shell reports them", async () => {
    const p = await createElectronPlatform(fakeBridge().bridge, detached());
    await expect(p.node!.resolve!("home.example")).resolves.toMatchObject({ domain: "home.example", web: "https://app.home.example" });
    await expect(p.node!.resolve!("nowhere.example")).rejects.toMatchObject({ code: "resolve.not_found", step: "direct" });
  });

  it("opens external links through the shell, only http(s) and mailto", async () => {
    const { bridge } = fakeBridge({ node: "https://tavrn.example" });
    const p = await createElectronPlatform(bridge, detached());
    await p.openExternal("https://example.org/x");
    expect(bridge.shell.openExternal).toHaveBeenCalledWith("https://example.org/x");
    await expect(p.openExternal("file:///etc/passwd")).rejects.toThrow();
    expect(bridge.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("opens the sign-in page again in the shell's window", async () => {
    const { bridge } = fakeBridge({ node: "https://home.example" });
    const p = await createElectronPlatform(bridge, detached());
    await p.auth?.reopen?.("https://home.example/connect?session=x");
    expect(bridge.shell.openConnect).toHaveBeenCalledWith("https://home.example/connect?session=x");
  });

  it("offers the updater only when the shell can update itself", async () => {
    expect((await createElectronPlatform(fakeBridge({ node: "https://tavrn.example" }, false).bridge, detached())).updater).toBeUndefined();
    const { bridge } = fakeBridge({ node: "https://tavrn.example" }, true);
    const p = await createElectronPlatform(bridge, detached());
    const update = await p.updater?.check();
    expect(update).toMatchObject({ version: "0.3.0", notes: "New things" });
    await update?.install();
    expect(bridge.updater.installUpdate).toHaveBeenCalled();
    bridge.updater.checkUpdate.mockResolvedValueOnce(null as never);
    await expect(p.updater?.check()).resolves.toBeNull();
  });

  it("installs the link handler: other sites open in the system browser", async () => {
    const { bridge } = fakeBridge({ node: "https://tavrn.example" });
    const doc = detached();
    await createElectronPlatform(bridge, doc);
    const a = doc.createElement("a");
    a.href = "https://example.org/page";
    doc.body.appendChild(a);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(bridge.shell.openExternal).toHaveBeenCalledWith("https://example.org/page");
  });
});

describe("the shell's other parts through the bridge", () => {
  it("hotkeys: registers through the shell and hands presses and releases to subscribers", async () => {
    const { bridge, emit } = fakeBridge({ node: "https://tavrn.example" });
    const p = await createElectronPlatform(bridge, detached());
    await expect(p.hotkeys?.register("toggle_mute", "control+Shift+KeyM")).resolves.toBe("Ctrl+Shift+KeyM");
    await expect(p.hotkeys?.register("push_to_talk", "Ctrl+KeyQ+KeyM")).rejects.toBe("hotkey.invalid");
    await p.hotkeys?.unregister("toggle_mute");
    expect(bridge.hotkeys.unregisterHotkey).toHaveBeenCalledWith("toggle_mute");
    await expect(p.hotkeys?.setEnabled(true)).resolves.toBe(true);
    const seen: HotkeyEvent[] = [];
    const off = p.hotkeys!.subscribe((e) => seen.push(e));
    emit({ channel: "hotkeys", event: { action: "push_to_talk", pressed: true } });
    emit({ channel: "hotkeys", event: { action: "self_destruct", pressed: true } });
    emit({ channel: "hotkeys", event: { action: "toggle_mute", pressed: "yes" } });
    off();
    emit({ channel: "hotkeys", event: { action: "push_to_talk", pressed: false } });
    expect(seen).toEqual([{ action: "push_to_talk", pressed: true }]);
  });

  it("notifications and tray: clicks and menu actions arrive as shell events, validated", async () => {
    const { bridge, emit } = fakeBridge({ node: "https://tavrn.example" });
    const p = await createElectronPlatform(bridge, detached());
    const opened: string[] = [];
    const actions: string[] = [];
    p.notifications!.onOpen((path) => opened.push(path));
    p.tray!.onAction((action) => actions.push(action));
    emit({ channel: "shell_events", event: { kind: "open", path: "/rooms/1/channels/2" } });
    emit({ channel: "shell_events", event: { kind: "open", path: "//evil.example/x" } });
    emit({ channel: "shell_events", event: { kind: "tray", action: "deafen" } });
    emit({ channel: "shell_events", event: { kind: "tray", action: "format_disk" } });
    emit(null);
    expect(opened).toEqual(["/rooms/1/channels/2"]);
    expect(actions).toEqual(["deafen"]);
    await expect(p.notifications!.show({ title: "t", body: "b", path: null })).rejects.toThrow("not implemented: notify");
    await expect(p.tray!.status()).resolves.toEqual({ state: "connected", tooltip: "tavrn", available: true, closeToTray: true });
    await p.tray!.setCloseToTray(false);
    expect(bridge.tray.setCloseToTray).toHaveBeenCalledWith(false);
    await p.tray!.quit();
    expect(bridge.tray.quitApp).toHaveBeenCalled();
  });

  it("keystore: 32-byte keys through the shell's keychain", async () => {
    const { bridge } = fakeBridge({ node: "https://tavrn.example" });
    const p = await createElectronPlatform(bridge, detached());
    await expect(p.keystore!.status()).resolves.toEqual({ backend: "secret-service", available: true });
    await expect(p.keystore!.get("alice@tavrn.example")).resolves.toEqual(new Uint8Array(32).fill(7));
    await p.keystore!.set("alice@tavrn.example", new Uint8Array(32));
    expect(bridge.keychain.keychainSet).toHaveBeenCalledWith("alice@tavrn.example", new Uint8Array(32));
    await p.keystore!.delete("alice@tavrn.example");
    expect(bridge.keychain.keychainDelete).toHaveBeenCalledWith("alice@tavrn.example");
  });

  it("downloads: streamed to the shell in 4 MiB pieces, aborted when a piece fails", async () => {
    const { bridge } = fakeBridge({ node: "https://tavrn.example" });
    const p = await createElectronPlatform(bridge, detached());
    const data = new Uint8Array(SAVE_CHUNK_BYTES + 10).fill(1);
    const out = await p.saveFile!({ name: "a.bin", data, mime: "application/octet-stream" });
    expect(bridge.files.saveFileBegin).toHaveBeenCalledWith("a.bin", "application/octet-stream", SAVE_CHUNK_BYTES + 10);
    expect(bridge.files.saveFileChunk.mock.calls.map((c) => (c as unknown as [string, Uint8Array])[1].byteLength)).toEqual([SAVE_CHUNK_BYTES, 10]);
    expect(out).toMatchObject({ status: "saved", name: "a.bin", path: "/home/u/Downloads/a.bin", folder: "Downloads" });
    if (out.status === "saved") await out.reveal?.();
    expect(bridge.files.saveFileReveal).toHaveBeenCalledWith("s1");
    bridge.files.saveFileChunk.mockRejectedValueOnce("save.write_failed" as never);
    await expect(p.saveFile!({ name: "b.bin", data: new Uint8Array(3) })).rejects.toBe("save.write_failed");
    expect(bridge.files.saveFileAbort).toHaveBeenCalledWith("s1");
    bridge.files.saveFileBegin.mockResolvedValueOnce({ status: "cancelled" } as never);
    await expect(p.saveFile!({ name: "c.bin", data: new Uint8Array(3) })).resolves.toEqual({ status: "cancelled" });
  });
});
