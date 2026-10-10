// SPDX-License-Identifier: Apache-2.0
/**
 * The native voice engine of the desktop app (docs/DESKTOP.md "Voice"): thin wrappers around the shell's `voice_*`
 * commands (`src-tauri/src/voice/mod.rs`). The engine's events come back over the IPC channel handed to `voice_join`;
 * frame keys travel as byte arrays and are never kept here. Loaded with `tauri.ts`, inside the app only.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { NativeVoiceEvent, PlatformVoice } from "./types";

export function voiceMember(): PlatformVoice {
  return {
    info: () => invoke<{ available: boolean; os: string }>("voice_info"),
    devices: () => invoke<{ inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[] }>("voice_devices"),
    join: (args, onEvent) => {
      const channel = new Channel<NativeVoiceEvent>(onEvent);
      return invoke<{ identity: string; can_speak: boolean }>("voice_join", { args: { ...args, key: Array.from(args.key) }, onEvent: channel });
    },
    leave: () => invoke<void>("voice_leave"),
    setKey: (key, epoch) => invoke<boolean>("voice_set_key", { key: Array.from(key), epoch }),
    setMuted: (muted) => invoke<void>("voice_set_muted", { muted }),
    setDeafened: (deafened) => invoke<void>("voice_set_deafened", { deafened }),
    setPtt: (pressed) => invoke<void>("voice_set_ptt", { pressed }),
    configure: (config) => invoke<void>("voice_configure", { config }),
    setVolumes: (volumes) => invoke<void>("voice_set_volumes", { volumes }),
  };
}
