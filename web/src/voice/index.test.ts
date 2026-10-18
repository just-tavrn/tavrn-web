// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPlatform, setPlatform, type PlatformVoice } from "../platform";
import { browserPlatform } from "../platform/browser";
import { resetEngineForTests, useVoiceEngine } from "./engine";
import { IDLE, useVoice } from "./store";
import { useVoiceSettings } from "./settings";
import * as voice from "./index";

const { browser, native } = vi.hoisted(() => {
  const engine = () => ({
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    followMove: vi.fn(async () => undefined),
    setMuted: vi.fn(async () => undefined),
    setDeafened: vi.fn(async () => undefined),
    setCamera: vi.fn(async () => undefined),
    setScreenShare: vi.fn(async () => undefined),
    playSound: vi.fn(async () => undefined),
    setPriority: vi.fn(async () => undefined),
    setWhisper: vi.fn(async () => undefined),
    pushToTalk: vi.fn(),
    attachVideo: vi.fn(() => () => undefined),
  });
  return { browser: engine(), native: engine() };
});
vi.mock("./session", () => browser);
vi.mock("./nativeSession", () => native);

const target = { domain: "home.example", roomId: "r1", channelId: "c1" };

function desktop(os: string) {
  const voice = { info: async () => ({ available: true, os }) } as unknown as PlatformVoice;
  setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, voice });
}

beforeEach(() => {
  for (const f of [...Object.values(browser), ...Object.values(native)]) f.mockClear();
});

afterEach(() => {
  resetPlatform();
  resetEngineForTests();
  useVoice.setState(IDLE);
  useVoiceSettings.getState().update({ nativeEngine: false });
});

describe("the voice entry point picks the engine", () => {
  it("delegates to the browser engine exactly as before", async () => {
    expect(await voice.joinVoice(target, { canCreate: true, start: false })).toBe(true);
    expect(browser.join).toHaveBeenCalledWith(target, { canCreate: true, start: false });
    await voice.toggleMute();
    expect(browser.setMuted).toHaveBeenCalledWith(true);
    await voice.toggleDeafen();
    expect(browser.setDeafened).toHaveBeenCalledWith(true);
    await voice.startScreenShare({ audio: "system", resolution: "1080p", fps: 30 });
    expect(browser.setScreenShare).toHaveBeenCalledWith(true, { audio: "system", resolution: "1080p", fps: 30 });
    voice.pushToTalk(true);
    expect(browser.pushToTalk).toHaveBeenCalledWith(true);
    voice.followMove("home.example", { room_id: "r1", from_channel_id: "c1", channel_id: "c2" });
    expect(browser.followMove).toHaveBeenCalled();
    expect(native.join).not.toHaveBeenCalled();
    expect(useVoiceEngine.getState().kind).toBe("browser");
  });

  it("uses the native engine in the Linux desktop app", async () => {
    desktop("linux");
    await voice.joinVoice(target, { canCreate: false });
    expect(native.join).toHaveBeenCalledWith(target, { canCreate: false });
    expect(browser.join).not.toHaveBeenCalled();
    expect(useVoiceEngine.getState().kind).toBe("native");
  });

  it("follows the Windows setting between calls, never during one", async () => {
    desktop("windows");
    await voice.joinVoice(target, { canCreate: true });
    expect(browser.join).toHaveBeenCalledTimes(1);
    useVoice.setState({ status: "connected", target });
    useVoiceSettings.getState().update({ nativeEngine: true });
    await voice.toggleMute();
    expect(browser.setMuted).toHaveBeenCalled();
    expect(native.setMuted).not.toHaveBeenCalled();
    useVoice.setState(IDLE);
    await voice.joinVoice(target, { canCreate: true });
    expect(native.join).toHaveBeenCalledTimes(1);
  });

  it("a failed join ends in a toast and false", async () => {
    browser.join.mockRejectedValueOnce(new Error("nope"));
    expect(await voice.joinVoice(target, { canCreate: true })).toBe(false);
  });
});


describe("whisper hold ownership and capability", () => {
  async function ready() {
    await voice.joinVoice(target, { canCreate: true });
    const media = { camera: false, screen: false, micMuted: false };
    useVoice.setState({ ...IDLE, target, status: "connected", whisperSupported: true, canWhisper: true, identity: "me@home.example/d", media: { "a@n/d": media, "b@n/d": media } });
    useVoiceSettings.getState().update({ whisperGroups: { "home.example/r1": [
      { id: "first", name: "First", members: ["a@n"] }, { id: "second", name: "Second", members: ["b@n"] },
    ] } });
  }
  it("does not offer a broadcast fallback without node support", async () => {
    await ready(); useVoice.setState({ whisperSupported: false });
    await voice.whisperTo(["a@n/d"]);
    expect(browser.setWhisper).not.toHaveBeenCalled();
  });
  it("an older group's keyup cannot stop the newer held group", async () => {
    await ready();
    voice.whisperHotkey("whisper:first", true);
    voice.whisperHotkey("whisper:second", true);
    voice.whisperHotkey("whisper:first", false);
    expect(browser.setWhisper.mock.calls).toEqual([[["a@n/d"]], [["b@n/d"]]]);
    voice.whisperHotkey("whisper:second", false);
    expect(browser.setWhisper).toHaveBeenLastCalledWith([]);
  });
  it("a held key from an old call cannot cancel a later touch hold", async () => {
    await ready(); voice.whisperHotkey("whisper:first", true);
    useVoice.setState(IDLE);
    await ready(); voice.whisperToAddress("b@n", true);
    browser.setWhisper.mockClear();
    voice.whisperHotkey("whisper:first", false);
    expect(browser.setWhisper).not.toHaveBeenCalled();
    voice.whisperToAddress("b@n", false);
    expect(browser.setWhisper).toHaveBeenCalledWith([]);
  });
});


describe("whisper initiation permission", () => {
  it("blocks direct, selected-person and group starts while allowing only the recorded reply", async () => {
    await voice.joinVoice(target, { canCreate: true });
    const media = { camera: false, screen: false, micMuted: false };
    useVoiceSettings.getState().update({ whisperGroups: { "home.example/r1": [{ id: "g", name: "Group", members: ["a@n"] }] } });
    useVoice.setState({ ...IDLE, target, status: "connected", whisperSupported: true, canWhisper: false, identity: "me@home.example/d", media: { "a@n/d": media, "b@n/d": media }, lastWhisperer: "a@n/d", lastWhisperSession: "received", lastWhisperExpiresAt: Date.now() + 120_000 });
    await voice.whisperTo(["a@n/d"]);
    voice.whisperToAddress("a@n", true);
    voice.whisperHotkey("whisper:g", true);
    await voice.whisperTo(["b@n/d"], true);
    expect(browser.setWhisper).not.toHaveBeenCalled();
    voice.whisperHotkey("whisper_reply", true);
    expect(browser.setWhisper).toHaveBeenCalledWith(["a@n/d"], "received");
    voice.whisperHotkey("whisper_reply", false);
    expect(browser.setWhisper).toHaveBeenLastCalledWith([]);
    browser.setWhisper.mockClear();
    useVoice.setState({ lastWhisperExpiresAt: Date.now() - 1 });
    voice.whisperHotkey("whisper_reply", true);
    expect(browser.setWhisper).not.toHaveBeenCalled();
  });
  it("permission revocation releases an active initiation", async () => {
    await voice.joinVoice(target, { canCreate: true });
    useVoice.setState({ ...IDLE, target, status: "connected", whisperSupported: true, canWhisper: true });
    await voice.whisperTo(["a@n/d"]);
    useVoice.setState({ canWhisper: false });
    expect(browser.setWhisper).toHaveBeenLastCalledWith([]);
  });
});
