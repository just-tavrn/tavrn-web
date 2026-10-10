// SPDX-License-Identifier: Apache-2.0
/** The bridge to the shell's keychain, notifications and tray (`tauriShell.ts`), with the Tauri IPC mocked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { shellMembers } from "./tauriShell";

type Calls = Array<{ cmd: string; args: Record<string, unknown> }>;

/** A fake shell; `channel` receives the client's event channel. */
function shell(handlers: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const calls: Calls = [];
  const state: { channel: Channel<unknown> | null } = { channel: null };
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "shell_events") {
      state.channel = a.onEvent as Channel<unknown>;
      return null;
    }
    const h = handlers[cmd];
    if (!h) throw `unknown command ${cmd}`;
    return h(a);
  });
  const emit = (event: unknown) => state.channel?.onmessage(event);
  return { calls, emit, state };
}

afterEach(() => clearMocks());

describe("keystore", () => {
  it("passes 32-byte keys to the shell and back as bytes", async () => {
    const stored = new Map<string, number[]>();
    const { calls } = shell({
      keychain_set: (a) => void stored.set(a.account as string, a.secret as number[]),
      keychain_get: (a) => stored.get(a.account as string) ?? null,
      keychain_delete: (a) => void stored.delete(a.account as string),
      keychain_status: () => ({ backend: "secret-service", available: true }),
    });
    const { keystore } = shellMembers();
    const key = new Uint8Array(32).map((_, i) => i);
    await keystore.set("alice@tavrn.example", key);
    expect(calls[0]).toEqual({ cmd: "keychain_set", args: { account: "alice@tavrn.example", secret: Array.from(key) } });
    const back = await keystore.get("alice@tavrn.example");
    expect(back).toBeInstanceOf(Uint8Array);
    expect(back).toEqual(key);
    await keystore.delete("alice@tavrn.example");
    await expect(keystore.get("alice@tavrn.example")).resolves.toBeNull();
    await expect(keystore.status()).resolves.toEqual({ backend: "secret-service", available: true });
  });

  it("passes the shell's refusal on", async () => {
    shell({
      keychain_get: () => {
        throw "keychain.unavailable";
      },
    });
    await expect(shellMembers().keystore.get("alice@tavrn.example")).rejects.toBe("keychain.unavailable");
  });
});

describe("notifications", () => {
  it("shows a notification through the shell and hands clicks to the subscribers", async () => {
    const { calls, emit } = shell({ notify: () => null });
    const { notifications } = shellMembers();
    await notifications.show({ title: "Alice", body: "Hi", path: "/dm/1" });
    expect(calls.find((c) => c.cmd === "notify")?.args).toEqual({ notice: { title: "Alice", body: "Hi", path: "/dm/1" } });
    const opened = vi.fn();
    const off = notifications.onOpen(opened);
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === "shell_events")).toBe(true));
    emit({ kind: "open", path: "/dm/1" });
    expect(opened).toHaveBeenCalledWith("/dm/1");
    off();
    emit({ kind: "open", path: "/dm/2" });
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe("tray", () => {
  it("sends the voice state with the texts and hands menu actions to the subscribers", async () => {
    const { calls, emit } = shell({ tray_set: () => null });
    const { tray, notifications } = shellMembers();
    const labels = { tooltip: "tavrn · General · Muted", show: "Show tavrn", hide: "Hide tavrn", mute: "Mute microphone", deafen: "Deafen", leave: "Leave voice channel", quit: "Quit tavrn" };
    await tray.set("muted", labels);
    expect(calls[0]).toEqual({ cmd: "tray_set", args: { state: "muted", labels } });
    const actions = vi.fn();
    tray.onAction(actions);
    const opened = vi.fn();
    notifications.onOpen(opened);
    await vi.waitFor(() => expect(calls.some((c) => c.cmd === "shell_events")).toBe(true));
    emit({ kind: "tray", action: "deafen" });
    emit({ kind: "tray", action: "explode" });
    emit({ kind: "open", path: "https://evil.example/" });
    expect(actions.mock.calls).toEqual([["deafen"]]);
    expect(opened).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.cmd === "shell_events")).toHaveLength(1);
  });

  it("reads the tray status and switches close to tray", async () => {
    const { calls } = shell({
      tray_status: () => ({ state: "connected", tooltip: "tavrn", available: true, close_to_tray: false }),
      set_close_to_tray: () => null,
      quit_app: () => null,
    });
    const { tray } = shellMembers();
    await expect(tray.status()).resolves.toEqual({ state: "connected", tooltip: "tavrn", available: true, closeToTray: false });
    await tray.setCloseToTray(true);
    expect(calls.at(-1)).toEqual({ cmd: "set_close_to_tray", args: { on: true } });
    await tray.quit();
    expect(calls.at(-1)?.cmd).toBe("quit_app");
  });
});
