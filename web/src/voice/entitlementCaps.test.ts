// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { VoiceLimits } from "@tavrn/sdk";
import { capLimits, withEntitlementCaps } from "./entitlementCaps";

const base: VoiceLimits = {
  audio_bitrate_kbps: 64,
  screenshare: { enabled: true, max_resolution: "1440p", max_fps: 60 },
  camera: { enabled: true, max_resolution: "1080p", max_fps: 30 },
  stream_max_height: 0,
  stream_max_fps: 0,
  camera_max_height: 0,
};

describe("voice entitlement caps", () => {
  it("leaves the node limits alone without caps", () => {
    expect(capLimits(base)).toEqual(base);
  });

  it("lowers resolution and fps to the caps, never raises them", () => {
    const capped = capLimits({ ...base, stream_max_height: 1080, stream_max_fps: 30, camera_max_height: 720 });
    expect(capped.screenshare.max_resolution).toBe("1080p");
    expect(capped.screenshare.max_fps).toBe(30);
    expect(capped.camera.max_resolution).toBe("720p");
    const higher = capLimits({ ...base, stream_max_height: 2160, stream_max_fps: 120, camera_max_height: 4320 });
    expect(higher.screenshare).toEqual(base.screenshare);
    expect(higher.camera).toEqual(base.camera);
  });

  it("keeps the smallest preset for caps below it and fits in-between heights", () => {
    expect(capLimits({ ...base, stream_max_height: 480 }).screenshare.max_resolution).toBe("720p");
    expect(capLimits({ ...base, camera_max_height: 240 }).camera.max_resolution).toBe("360p");
    expect(capLimits({ ...base, stream_max_height: 1200 }).screenshare.max_resolution).toBe("1080p");
    expect(withEntitlementCaps({ token: "x", limits: { ...base, stream_max_height: 720 } }).limits.screenshare.max_resolution).toBe("720p");
  });
});
