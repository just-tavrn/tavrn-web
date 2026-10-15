// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { voiceMember } from "./tauriVoice";
import type { NativeVoiceEvent } from "./types";

afterEach(() => clearMocks());

describe("the native voice engine's commands", () => {
  it("hand the key over as bytes and the events back over the channel", async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    let channel: Channel<NativeVoiceEvent> | null = null;
    mockWindows("main");
    const keysSent: number[][] = [];
    mockIPC((cmd, args) => {
      // What crosses the bridge is serialized at once: record a copy (the client wipes its array afterwards).
      calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
      const a = args as { args?: { key?: number[] }; key?: number[] };
      const key = a.args?.key ?? a.key;
      if (key) keysSent.push(key);
      if (cmd === "voice_join") {
        channel = (args as { onEvent: Channel<NativeVoiceEvent> }).onEvent;
        return { identity: "me@home.example/1", can_speak: true };
      }
      if (cmd === "voice_info") return { available: true, os: "linux" };
      if (cmd === "voice_set_key") return true;
      return null;
    });
    const voice = voiceMember();
    expect(await voice.info()).toEqual({ available: true, os: "linux" });
    const events: NativeVoiceEvent[] = [];
    const config = { inputDevice: null, outputDevice: null, inputVolume: 100, echoCancellation: true, noiseSuppression: true, autoGain: true, ptt: false, threshold: -55, holdMs: 300, pttReleaseMs: 250 };
    const reply = await voice.join({ url: "wss://v.example", token: "t", key: new Uint8Array([1, 2, 3]), epoch: 4, bitrateKbps: 32, config, muted: false, deafened: true }, (e) => events.push(e));
    expect(reply).toEqual({ identity: "me@home.example/1", can_speak: true });
    const join = calls.find((c) => c.cmd === "voice_join")!;
    expect(join.args.args).toEqual({ url: "wss://v.example", token: "t", key: [1, 2, 3], epoch: 4, bitrateKbps: 32, config, muted: false, deafened: true });
    expect(channel).not.toBeNull();
    expect(await voice.setKey(new Uint8Array([9, 9]), 5)).toBe(true);
    expect(calls.find((c) => c.cmd === "voice_set_key")!.args).toEqual({ key: [9, 9], epoch: 5 });
    // The number arrays handed to the bridge are wiped once the calls are done.
    expect(keysSent).toHaveLength(2);
    for (const k of keysSent) expect(k.every((b) => b === 0)).toBe(true);
    await voice.setMuted(true);
    await voice.setDeafened(false);
    await voice.setPtt(true);
    await voice.setVolumes({ "bob/1": 0.5 });
    await voice.configure(config);
    await voice.leave();
    expect(calls.map((c) => c.cmd)).toEqual(["voice_info", "voice_join", "voice_set_key", "voice_set_muted", "voice_set_deafened", "voice_set_ptt", "voice_set_volumes", "voice_configure", "voice_leave"]);
    expect(calls.find((c) => c.cmd === "voice_set_volumes")!.args).toEqual({ volumes: { "bob/1": 0.5 } });
  });
});
