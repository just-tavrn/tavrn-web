// SPDX-License-Identifier: Apache-2.0
/**
 * The UI side of the native voice engine (`engine.ts`): whether the current or next call uses it, and its own device
 * lists for Settings → Voice & video and the quick menus. The native engine names its microphones and speakers itself
 * (PulseAudio, ALSA, WASAPI ids, not the browser's), so their choice lives in separate settings
 * (`nativeInputDeviceId`, `nativeOutputDeviceId`): switching engines never hands one engine the other's ids.
 */
import { useEffect, useState } from "react";
import { platform, type NativeDevice } from "../platform";
import { chooseEngine, nativeInfo, useVoiceEngine } from "./engine";
import { useVoiceSettings, type VoiceSettings } from "./settings";
import { useVoice } from "./store";

/** Whether the voice of this client runs in the native engine: the running call's engine, else the next call's. */
export function useNativeVoice(): boolean {
  const engine = useVoiceEngine();
  const setting = useVoiceSettings((s) => s.settings.nativeEngine);
  const inCall = useVoice((s) => s.status !== "idle");
  useEffect(() => {
    void nativeInfo();
  }, []);
  if (inCall) return engine.kind === "native";
  return chooseEngine({ desktop: platform().isDesktop, os: engine.os, available: engine.available, setting }) === "native";
}

/** A native device in the shape of the browser's `MediaDeviceInfo` (the device lists and menus take those). */
export function asMediaDevice(d: NativeDevice, kind: "audioinput" | "audiooutput"): MediaDeviceInfo {
  return { deviceId: d.id, label: d.label, kind, groupId: "", toJSON: () => ({ deviceId: d.id, label: d.label, kind }) } as MediaDeviceInfo;
}

/** The native engine's microphones and speakers (listed when `enabled`, again whenever `refresh` changes). */
export function useNativeDevices(enabled: boolean, refresh = 0): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const voice = platform().voice;
    if (!enabled || !voice) return;
    let live = true;
    void voice.devices().then(
      (d) => live && setDevices([...d.inputs.map((x) => asMediaDevice(x, "audioinput")), ...d.outputs.map((x) => asMediaDevice(x, "audiooutput"))]),
      () => live && setDevices([]),
    );
    return () => {
      live = false;
    };
  }, [enabled, refresh]);
  return enabled ? devices : [];
}

/** The settings as the device lists see them: with the native engine its own device choice. */
export function deviceView(s: VoiceSettings, native: boolean): VoiceSettings {
  return native ? { ...s, inputDeviceId: s.nativeInputDeviceId, outputDeviceId: s.nativeOutputDeviceId } : s;
}

/** A device choice of the lists as the settings keep it: with the native engine in its own fields. */
export function devicePatch(patch: Partial<VoiceSettings>, native: boolean): Partial<VoiceSettings> {
  if (!native) return patch;
  const { inputDeviceId, outputDeviceId, ...rest } = patch;
  return {
    ...rest,
    ...(inputDeviceId !== undefined ? { nativeInputDeviceId: inputDeviceId } : {}),
    ...(outputDeviceId !== undefined ? { nativeOutputDeviceId: outputDeviceId } : {}),
  };
}
