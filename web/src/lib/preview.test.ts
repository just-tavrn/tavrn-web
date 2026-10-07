// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_MAX_BYTES, isAutoPreview, isSvg, safeBlobType, shouldAutoPreview, type PreviewInput } from "./preview";

const base: PreviewInput = { setting: "friends_and_shared", size: 1000, maxBytes: DEFAULT_PREVIEW_MAX_BYTES, own: false, inRoom: false, friend: false };

describe("shouldAutoPreview", () => {
  it("friends_and_shared: own messages, room members and friends load, strangers in DMs do not", () => {
    expect(shouldAutoPreview(base)).toBe(false);
    expect(shouldAutoPreview({ ...base, own: true })).toBe(true);
    expect(shouldAutoPreview({ ...base, inRoom: true })).toBe(true);
    expect(shouldAutoPreview({ ...base, friend: true })).toBe(true);
  });

  it("always loads everything up to the cap, never loads nothing", () => {
    expect(shouldAutoPreview({ ...base, setting: "always" })).toBe(true);
    for (const who of [{ own: true }, { inRoom: true }, { friend: true }, {}]) {
      expect(shouldAutoPreview({ ...base, ...who, setting: "never" })).toBe(false);
    }
  });

  it("the size cap applies to every setting", () => {
    const big = { ...base, size: DEFAULT_PREVIEW_MAX_BYTES + 1 };
    expect(shouldAutoPreview({ ...big, setting: "always" })).toBe(false);
    expect(shouldAutoPreview({ ...big, own: true })).toBe(false);
    expect(shouldAutoPreview({ ...base, size: DEFAULT_PREVIEW_MAX_BYTES, inRoom: true })).toBe(true);
    expect(shouldAutoPreview({ ...base, inRoom: true, maxBytes: 0, size: 0 })).toBe(false);
    expect(shouldAutoPreview({ ...base, inRoom: true, size: Number.NaN })).toBe(false);
  });

  it("validates stored values", () => {
    expect(isAutoPreview("never")).toBe(true);
    expect(isAutoPreview("sometimes")).toBe(false);
    expect(isAutoPreview(undefined)).toBe(false);
  });
});

describe("SVG and object URL types", () => {
  it("recognizes SVG by type or name", () => {
    expect(isSvg("image/svg+xml")).toBe(true);
    expect(isSvg("IMAGE/SVG+XML; charset=utf-8")).toBe(true);
    expect(isSvg("image/png", "logo.SVG")).toBe(true);
    expect(isSvg("application/octet-stream", "x.svgz")).toBe(true);
    expect(isSvg("image/png", "logo.png")).toBe(false);
  });

  it("only raster images, audio and video keep their type", () => {
    expect(safeBlobType("image/png")).toBe("image/png");
    expect(safeBlobType("video/mp4")).toBe("video/mp4");
    expect(safeBlobType("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(safeBlobType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeBlobType("image/png", "evil.svg")).toBe("application/octet-stream");
    expect(safeBlobType("text/html")).toBe("application/octet-stream");
    expect(safeBlobType("application/xhtml+xml")).toBe("application/octet-stream");
    expect(safeBlobType("")).toBe("application/octet-stream");
  });
});
