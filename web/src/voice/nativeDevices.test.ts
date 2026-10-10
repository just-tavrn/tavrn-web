// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { asMediaDevice, devicePatch, deviceView } from "./nativeDevices";
import { DEFAULT_SETTINGS } from "./settings";

describe("native device choice", () => {
  const s = { ...DEFAULT_SETTINGS, inputDeviceId: "browser-mic", outputDeviceId: "browser-out", nativeInputDeviceId: "pulseaudio:mic", nativeOutputDeviceId: "" };

  it("the lists see the native engine's own choice", () => {
    expect(deviceView(s, true)).toMatchObject({ inputDeviceId: "pulseaudio:mic", outputDeviceId: "" });
    expect(deviceView(s, false)).toBe(s);
  });

  it("a choice lands in the engine's own fields, other changes pass through", () => {
    expect(devicePatch({ inputDeviceId: "alsa:hw1", inputVolume: 80 }, true)).toEqual({ nativeInputDeviceId: "alsa:hw1", inputVolume: 80 });
    expect(devicePatch({ outputDeviceId: "" }, true)).toEqual({ nativeOutputDeviceId: "" });
    expect(devicePatch({ inputDeviceId: "x" }, false)).toEqual({ inputDeviceId: "x" });
  });

  it("native devices look like the browser's", () => {
    const d = asMediaDevice({ id: "wasapi:{1}", label: "Headset" }, "audiooutput");
    expect(d).toMatchObject({ deviceId: "wasapi:{1}", label: "Headset", kind: "audiooutput" });
  });
});
