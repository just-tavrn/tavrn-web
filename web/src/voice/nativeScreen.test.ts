// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { AndroidScreenEvent, AndroidScreenShare, AndroidScreenShareStart } from "../platform/types";
import { NativeScreenShare, NoFrameKeyError, screenCapture, type NativeScreenState } from "./nativeScreen";

const LIMIT = { enabled: true, max_resolution: "1080p", max_fps: 30 };

function fakeShell(opts: { audio?: boolean; start?: (args: AndroidScreenShareStart) => Promise<void> } = {}) {
  const listeners = new Set<(e: AndroidScreenEvent) => void>();
  const keys: Array<{ key: number[]; epoch: number }> = [];
  const started: Array<Omit<AndroidScreenShareStart, "key"> & { key: number[] }> = [];
  const shell: AndroidScreenShare & { emit(e: AndroidScreenEvent): void; listeners: number } = {
    audio: opts.audio ?? true,
    start: vi.fn(async (args: AndroidScreenShareStart) => {
      started.push({ ...args, key: [...args.key] });
      await opts.start?.(args);
    }),
    setKey: vi.fn(async (key: Uint8Array, epoch: number) => {
      keys.push({ key: [...key], epoch });
    }),
    stop: vi.fn(async () => undefined),
    onEvent: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    emit: (e) => listeners.forEach((fn) => fn(e)),
    get listeners() {
      return listeners.size;
    },
  };
  return { shell, keys, started };
}

function setup(o: { key?: () => { key: Uint8Array; epoch: number } | null; shell?: ReturnType<typeof fakeShell>; join?: () => Promise<{ url: string; token: string }> } = {}) {
  const f = o.shell ?? fakeShell();
  const states: Array<[NativeScreenState, string | undefined]> = [];
  const handed: Uint8Array[] = [];
  const deps = {
    shell: f.shell,
    join: vi.fn(o.join ?? (async () => ({ url: "wss://n.example", token: "screen-token" }))),
    leave: vi.fn(async () => undefined),
    key: vi.fn(
      o.key ??
        (() => {
          const k = { key: new Uint8Array(32).fill(7), epoch: 4 };
          handed.push(k.key);
          return k;
        }),
    ),
    notice: () => ({ title: "Sharing your screen", text: "In Lounge", stop: "Stop sharing" }),
    onState: (s: NativeScreenState, reason?: string) => void states.push([s, reason]),
  };
  return { ctl: new NativeScreenShare(deps), deps, ...f, states, handed };
}

describe("the Android app's screen share (VOICE.md §4b)", () => {
  it("joins as the screen publisher and hands the shell the token and this device's frame key", async () => {
    const { ctl, deps, started, states, handed } = setup();
    await ctl.start({ resolution: "1440p", fps: 60, audio: true }, LIMIT);
    expect(deps.join).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
    const s = started[0]!;
    expect(s.url).toBe("wss://n.example");
    expect(s.token).toBe("screen-token");
    expect(s.key).toEqual(Array(32).fill(7));
    expect(s.epoch).toBe(4);
    // Within the node's limits: 1440p and 60 fps are lowered to 1080p and 30 fps.
    expect([s.maxSide, s.fps]).toEqual([1920, 30]);
    expect(s.maxBitrate).toBe(Math.round(1920 * 1080 * 30 * 0.05));
    expect(s.audio).toBe(true);
    expect(s.notice.stop).toBe("Stop sharing");
    expect(states).toEqual([
      ["starting", undefined],
      ["live", undefined],
    ]);
    expect(ctl.active).toBe(true);
    // The copy of the key is wiped once the shell has it.
    expect([...handed[0]!].every((b) => b === 0)).toBe(true);
  });

  it("asks for no system audio where Android cannot capture it (before Android 10)", async () => {
    const { ctl, started } = setup({ shell: fakeShell({ audio: false }) });
    await ctl.start({ resolution: "720p", fps: 15, audio: true }, LIMIT);
    expect(started[0]!.audio).toBe(false);
    expect([started[0]!.maxSide, started[0]!.fps]).toEqual([1280, 15]);
  });

  it("never starts without a frame key, and not when the node forbids sharing", async () => {
    const { ctl, deps, states } = setup({ key: () => null });
    await expect(ctl.start({ resolution: "1080p", fps: 30, audio: false }, LIMIT)).rejects.toBeInstanceOf(NoFrameKeyError);
    expect(deps.join).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual([null, undefined]);
    const other = setup();
    await other.ctl.start({ resolution: "1080p", fps: 30, audio: false }, { ...LIMIT, enabled: false });
    expect(other.deps.join).not.toHaveBeenCalled();
    expect(other.ctl.active).toBe(false);
  });

  it("lets the node go when the user declines Android's consent", async () => {
    const shell = fakeShell({ start: async () => Promise.reject("screen.cancelled") });
    const { ctl, deps, states } = setup({ shell });
    await expect(ctl.start({ resolution: "1080p", fps: 30, audio: false }, LIMIT)).rejects.toBe("screen.cancelled");
    expect(deps.leave).toHaveBeenCalledTimes(1);
    expect(ctl.active).toBe(false);
    expect(states.map((x) => x[0])).toEqual(["starting", null]);
  });

  it("hands every newer epoch's key to the shell, also one that arrived while starting", async () => {
    let release!: () => void;
    const shell = fakeShell({ start: () => new Promise<void>((r) => (release = r)) });
    const { ctl, keys } = setup({ shell });
    const starting = ctl.start({ resolution: "1080p", fps: 30, audio: false }, LIMIT);
    await vi.waitFor(() => expect(shell.started).toHaveLength(1));
    const early = { key: new Uint8Array(32).fill(5), epoch: 5 };
    await ctl.rekey(early);
    expect(keys).toEqual([]);
    release();
    await starting;
    expect(keys).toEqual([{ key: Array(32).fill(5), epoch: 5 }]);
    expect([...early.key].every((b) => b === 0)).toBe(true);
    // Older or equal epochs are ignored (and wiped); newer ones go through.
    const old = { key: new Uint8Array(32).fill(3), epoch: 3 };
    await ctl.rekey(old);
    expect([...old.key].every((b) => b === 0)).toBe(true);
    await ctl.rekey({ key: new Uint8Array(32).fill(6), epoch: 6 });
    expect(keys.map((k) => k.epoch)).toEqual([5, 6]);
    // Not sharing: nothing goes to the shell.
    await ctl.stop();
    await ctl.rekey({ key: new Uint8Array(32).fill(8), epoch: 8 });
    expect(keys.map((k) => k.epoch)).toEqual([5, 6]);
  });

  it("stops from the controls and from the notification, and lets the node go each time", async () => {
    const { ctl, deps, shell, states } = setup();
    await ctl.start({ resolution: "1080p", fps: 30, audio: false }, LIMIT);
    await ctl.stop();
    expect(shell.stop).toHaveBeenCalledTimes(1);
    expect(deps.leave).toHaveBeenCalledTimes(1);
    expect(ctl.active).toBe(false);
    await ctl.start({ resolution: "1080p", fps: 30, audio: false }, LIMIT);
    shell.emit({ state: "stopped", reason: "notification" });
    expect(states.at(-1)).toEqual([null, "notification"]);
    await vi.waitFor(() => expect(deps.leave).toHaveBeenCalledTimes(2));
    expect(shell.stop).toHaveBeenCalledTimes(1);
    // A late event changes nothing.
    shell.emit({ state: "stopped", reason: "revoked" });
    expect(deps.leave).toHaveBeenCalledTimes(2);
    await ctl.dispose();
    expect(shell.listeners).toBe(0);
  });

  it("captures the resolution's box and keeps the bitrate within 8 Mbit/s", () => {
    expect(screenCapture({ resolution: "4k", fps: 60 }, { enabled: true, max_resolution: "4k", max_fps: 60 })).toEqual({ maxSide: 3840, fps: 60, maxBitrate: 8_000_000 });
    expect(screenCapture({ resolution: "720p", fps: 0 }, LIMIT)).toEqual({ maxSide: 1280, fps: 1, maxBitrate: Math.round(1280 * 720 * 0.05) });
  });
});
