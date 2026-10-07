// SPDX-License-Identifier: Apache-2.0
/**
 * Entitlement caps of a voice token (tavrn-protocol/ENTITLEMENTS.md §4): `stream_max_height`, `stream_max_fps` and
 * `camera_max_height` (0 = no cap beyond the node's `screenshare`/`camera` limits) are folded into those
 * limits once at join, so the existing publish code (`setScreenShare`, `cameraOptions`) applies them. A soft
 * limit: the SFU cannot enforce it against a modified client. Caps below the smallest preset keep that preset.
 */
import type { VoiceLimits } from "@tavrn/sdk";

const HEIGHTS: Array<[string, number]> = [
  ["360p", 360],
  ["720p", 720],
  ["1080p", 1080],
  ["1440p", 1440],
  ["4k", 2160],
];

/** The highest preset of `allowed` not above `cap` and not above `current` (unknown `current`: unchanged). */
function lowerTo(current: string, cap: number, allowed: string[]): string {
  if (!cap) return current;
  const height = HEIGHTS.find(([r]) => r === current)?.[1];
  if (height === undefined || height <= cap) return current;
  const fits = HEIGHTS.filter(([r, h]) => allowed.includes(r) && h <= cap);
  return fits.at(-1)?.[0] ?? allowed[0] ?? current;
}

export function capLimits(limits: VoiceLimits): VoiceLimits {
  const streamFps = limits.stream_max_fps ?? 0;
  return {
    ...limits,
    screenshare: {
      ...limits.screenshare,
      max_resolution: lowerTo(limits.screenshare.max_resolution, limits.stream_max_height ?? 0, ["720p", "1080p", "1440p", "4k"]),
      max_fps: streamFps > 0 ? Math.min(limits.screenshare.max_fps, streamFps) : limits.screenshare.max_fps,
    },
    camera: { ...limits.camera, max_resolution: lowerTo(limits.camera.max_resolution, limits.camera_max_height ?? 0, ["360p", "720p", "1080p"]) },
  };
}

/** The join answer with its limits capped (see {@link capLimits}). */
export function withEntitlementCaps<T extends { limits: VoiceLimits }>(info: T): T {
  return { ...info, limits: capLimits(info.limits) };
}
