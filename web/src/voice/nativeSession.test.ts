// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform, type NativeVoiceEvent, type NativeVoiceJoin, type PlatformVoice } from "../platform";
import { browserPlatform } from "../platform/browser";
import { IDLE, useSpeaking, useVoice } from "./store";
import { DEFAULT_SETTINGS, useVoiceSettings } from "./settings";
import { qualify } from "@tavrn/e2ee";

const h = vi.hoisted(() => {
  const state = { epoch: 5, key: 0x11 };
  const mls = {
    ensureJoined: vi.fn(async () => "joined" as const),
    selfUpdate: vi.fn(async () => true),
    catchUp: vi.fn(async () => undefined),
    epoch: vi.fn(() => state.epoch),
    // A fresh buffer per call, like the MLS manager's exporter output.
    voiceKey: vi.fn(() => ({ epoch: state.epoch, key: new Uint8Array(32).fill(state.key) })),
  };
  const api = {
    voice: {
      join: vi.fn(async () => ({ url: "wss://voice.home.example", token: "lk-token", epoch: 5, limits: { audio_bitrate_kbps: 64, camera: { enabled: true }, screenshare: { enabled: true } }, reconnect_grace_secs: 30, participants: [] })),
      leave: vi.fn(async () => undefined),
      updateState: vi.fn(async () => undefined),
    },
  };
  return { state, mls, api };
});

vi.mock("../stores/mls", async () => {
  const { create } = await import("zustand");
  return { getMls: async () => h.mls, useMlsUi: create(() => ({ epochs: {} as Record<string, number> })) };
});
vi.mock("../stores/nodes", () => ({ apiFor: () => h.api }));
vi.mock("../lib/leafCleanup", () => ({ cleanupBeforeVoice: async () => () => undefined, loadPending: async () => [] }));
vi.mock("./cues", () => ({ playCue: vi.fn() }));
vi.mock("./entitlementCaps", () => ({ withEntitlementCaps: (i: unknown) => i }));

const { useMlsUi } = await import("../stores/mls");
const session = await import("./nativeSession");

const target = { domain: "home.example", roomId: "r1", channelId: "c1" };
const q = qualify("home.example", "c1");

interface Fake {
  voice: PlatformVoice;
  joins: Array<{ args: NativeVoiceJoin; key: number[] }>;
  emit: (e: NativeVoiceEvent) => void;
  calls: Array<[string, unknown]>;
}

function fakeShell(fail?: string): Fake {
  const fake: Fake = { joins: [], emit: () => undefined, calls: [], voice: null as unknown as PlatformVoice };
  const call = (name: string) => async (arg?: unknown) => {
    fake.calls.push([name, arg instanceof Uint8Array ? Array.from(arg) : arg]);
  };
  fake.voice = {
    info: async () => ({ available: true, os: "linux" }),
    devices: async () => ({ inputs: [], outputs: [] }),
    join: async (args, onEvent) => {
      // What travels over IPC is a copy of the key at the time of the call.
      fake.joins.push({ args, key: Array.from(args.key) });
      fake.emit = onEvent;
      if (fail) throw fail;
      return { identity: "me@home.example/1", can_speak: true };
    },
    leave: call("leave") as () => Promise<void>,
    setKey: async (key, epoch) => {
      fake.calls.push(["setKey", [Array.from(key)[0], epoch]]);
      return true;
    },
    setMuted: call("setMuted") as (m: boolean) => Promise<void>,
    setDeafened: call("setDeafened") as (d: boolean) => Promise<void>,
    setPtt: call("setPtt") as (p: boolean) => Promise<void>,
    configure: call("configure") as PlatformVoice["configure"],
    setVolumes: call("setVolumes") as PlatformVoice["setVolumes"],
  };
  setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, voice: fake.voice });
  return fake;
}

const calls = (f: Fake, name: string) => f.calls.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  h.state.epoch = 5;
  h.state.key = 0x11;
  vi.clearAllMocks();
});

afterEach(async () => {
  await session.leave();
  resetPlatform();
  useVoice.setState(IDLE);
  useVoiceSettings.getState().update({ ...DEFAULT_SETTINGS });
});

describe("the native engine's session", () => {
  it("joins the group, the node and the room with the current epoch's key", async () => {
    const f = fakeShell();
    await session.join(target, { canCreate: true });
    expect(h.mls.ensureJoined).toHaveBeenCalledWith(q, { canCreate: true, priority: true });
    expect(h.mls.selfUpdate).toHaveBeenCalledWith(q, { priority: true });
    expect(h.api.voice.join).toHaveBeenCalledWith("r1", "c1");
    expect(f.joins).toHaveLength(1);
    const { args, key } = f.joins[0]!;
    expect(key).toEqual(new Array(32).fill(0x11));
    expect(args).toMatchObject({ url: "wss://voice.home.example", token: "lk-token", epoch: 5, bitrateKbps: 64, muted: false, deafened: false });
    expect(args.config).toMatchObject({ inputDevice: null, ptt: false, threshold: -55, echoCancellation: true });
    // The key buffer is wiped once the shell has it.
    expect(Array.from(args.key).every((b) => b === 0)).toBe(true);
    expect(useVoice.getState()).toMatchObject({ status: "connected", identity: "me@home.example/1", e2ee: true, canSpeak: true, serverMuted: false });
    expect(h.api.voice.updateState).toHaveBeenCalledWith("r1", "c1", { muted: false, deafened: false });
  });

  it("maps the engine's events to the call's state", async () => {
    const f = fakeShell();
    await session.join(target, { canCreate: true });
    f.emit({ kind: "participants", participants: [{ identity: "me@home.example/1", mic: true, mic_muted: false, local: true }, { identity: "bob@b.example/2", mic: true, mic_muted: true, local: false }] });
    expect(useVoice.getState().media["bob@b.example/2"]).toEqual({ camera: false, screen: false, micMuted: true, screenAudio: false });
    // A new remote participant gets its volume (100 % × 100 %).
    expect(calls(f, "setVolumes").at(-1)).toEqual({ "bob@b.example/2": 1 });
    f.emit({ kind: "level", level: -20, open: true });
    expect(useVoice.getState().transmitting).toBe(true);
    f.emit({ kind: "speakers", levels: [["bob@b.example/2", -30]] });
    useSpeaking.getState();
    await vi.waitFor(() => expect(Object.keys(useSpeaking.getState().levels).sort()).toEqual(["bob@b.example/2", "me@home.example/1"]));
    f.emit({ kind: "quality", identity: "me@home.example/1", quality: "poor" });
    expect(useVoice.getState().quality).toBe("poor");
    f.emit({ kind: "permissions", can_speak: false });
    expect(useVoice.getState()).toMatchObject({ canSpeak: false, serverMuted: true, muted: true });
    expect(calls(f, "setMuted").at(-1)).toBe(true);
    f.emit({ kind: "reconnecting" });
    expect(useVoice.getState().status).toBe("reconnecting");
    f.emit({ kind: "reconnected" });
    expect(useVoice.getState().status).toBe("connected");
  });

  it("hands the key of every newer epoch to the shell, never an older one", async () => {
    const f = fakeShell();
    await session.join(target, { canCreate: true });
    expect(calls(f, "setKey")).toEqual([]);
    h.state.epoch = 6;
    h.state.key = 0x22;
    useMlsUi.setState({ epochs: { [q]: 1 } });
    await vi.waitFor(() => expect(calls(f, "setKey")).toEqual([[0x22, 6]]));
    // The same epoch again, then an older one: nothing new reaches the shell.
    useMlsUi.setState({ epochs: { [q]: 2 } });
    h.state.epoch = 4;
    useMlsUi.setState({ epochs: { [q]: 3 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls(f, "setKey")).toEqual([[0x22, 6]]);
  });

  it("mute and deafen follow the rules of the browser engine", async () => {
    const f = fakeShell();
    await session.join(target, { canCreate: true });
    f.emit({ kind: "participants", participants: [{ identity: "bob@b.example/2", mic: true, mic_muted: false, local: false }] });
    await session.setMuted(true);
    expect(calls(f, "setMuted").at(-1)).toBe(true);
    expect(h.api.voice.updateState).toHaveBeenLastCalledWith("r1", "c1", { muted: true });
    await session.setDeafened(true);
    expect(calls(f, "setDeafened").at(-1)).toBe(true);
    expect(calls(f, "setVolumes").at(-1)).toEqual({ "bob@b.example/2": 0 });
    // Undeafening restores the mute state from before (muted).
    await session.setDeafened(false);
    expect(useVoice.getState()).toMatchObject({ deafened: false, muted: true });
    // Unmuting while deafened also undeafens.
    await session.setDeafened(true);
    await session.setMuted(false);
    expect(useVoice.getState()).toMatchObject({ deafened: false, muted: false });
    expect(calls(f, "setDeafened").at(-1)).toBe(false);
  });

  it("push-to-talk and settings changes reach the shell", async () => {
    const f = fakeShell();
    await session.join(target, { canCreate: true });
    session.pushToTalk(true);
    expect(calls(f, "setPtt").at(-1)).toBe(true);
    useVoiceSettings.getState().update({ inputMode: "ptt", nativeInputDeviceId: "pulseaudio:usb" });
    await vi.waitFor(() => expect(calls(f, "configure").at(-1)).toMatchObject({ ptt: true, inputDevice: "pulseaudio:usb", holdMs: 0 }));
    useVoiceSettings.getState().update({ userVolumes: { "bob@b.example": 50 } });
    f.emit({ kind: "participants", participants: [{ identity: "bob@b.example/2", mic: true, mic_muted: false, local: false }] });
    expect(calls(f, "setVolumes").at(-1)).toEqual({ "bob@b.example/2": 0.5 });
  });

  it("a deleted room ends the call; leaving tells the shell and the node", async () => {
    const f = fakeShell();
    await session.join(target, { canCreate: true });
    f.emit({ kind: "disconnected", reason: "room_deleted" });
    await vi.waitFor(() => expect(useVoice.getState().status).toBe("idle"));
    expect(calls(f, "leave")).toHaveLength(1);
    await session.join(target, { canCreate: true });
    await session.leave();
    expect(calls(f, "leave")).toHaveLength(2);
    expect(h.api.voice.leave).toHaveBeenCalledWith("r1", "c1");
  });

  it("a failed encryption setup frees the seat and says why", async () => {
    fakeShell("voice.e2ee_failed");
    await expect(session.join(target, { canCreate: true })).rejects.toMatchObject({ code: "e2ee_failed" });
    expect(h.api.voice.leave).toHaveBeenCalledWith("r1", "c1");
    expect(useVoice.getState().status).toBe("idle");
    expect(useVoice.getState().error).toBeTruthy();
  });

  it("switching channels: the previous channel's leave does not hold the next join, a join back waits for it", async () => {
    fakeShell();
    await session.join(target, { canCreate: true });
    let finish!: () => void;
    h.api.voice.leave.mockImplementationOnce(() => new Promise<undefined>((r) => (finish = () => r(undefined))));
    const other = { ...target, channelId: "c2" };
    await session.join(other, { canCreate: true });
    expect(useVoice.getState()).toMatchObject({ status: "connected", target: other });
    expect(h.api.voice.leave).toHaveBeenCalledWith("r1", "c1");
    // Back to c1 while its leave is still on the way: the join waits, or the late leave would end it.
    let back = false;
    const returning = session.join(target, { canCreate: true }).then(() => (back = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(back).toBe(false);
    expect(h.api.voice.join).toHaveBeenCalledTimes(2);
    finish();
    await returning;
    expect(h.api.voice.join).toHaveBeenCalledTimes(3);
    expect(useVoice.getState().target).toEqual(target);
  });

  it("camera, screen and soundboard do nothing in this engine", async () => {
    fakeShell();
    await session.join(target, { canCreate: true });
    await session.setCamera(true);
    await session.setScreenShare(true);
    expect(useVoice.getState()).toMatchObject({ camera: false, screen: false });
    expect(session.attachVideo("x", "camera", document.createElement("video"))).toBeTypeOf("function");
  });
});
