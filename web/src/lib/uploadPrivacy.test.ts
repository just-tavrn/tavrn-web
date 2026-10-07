// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StripResult } from "./metadata";

const inspect = vi.fn<(f: File) => Promise<StripResult>>();
const strip = vi.fn<(f: File) => Promise<StripResult>>();
vi.mock("./metadata", () => ({ inspectMetadata: (f: File) => inspect(f), stripImageMetadata: (f: File) => strip(f) }));
const { prepareUpload } = await import("./uploadPrivacy");

const original = new File([new Uint8Array([1])], "a.jpg", { type: "image/jpeg" });
const cleaned = new File([new Uint8Array([2])], "a.jpg", { type: "image/jpeg" });
const found = (over: Partial<StripResult> = {}): StripResult => ({ file: original, removed: ["exif"], warnings: [], kind: "jpeg", ...over });

describe("prepareUpload", () => {
  beforeEach(() => {
    inspect.mockReset().mockResolvedValue(found());
    strip.mockReset().mockResolvedValue(found({ file: cleaned }));
  });

  it("always: strips silently and notes it", async () => {
    const ask = vi.fn();
    expect(await prepareUpload(original, "always", ask)).toEqual({ file: cleaned, note: "removed" });
    expect(ask).not.toHaveBeenCalled();
    strip.mockResolvedValue(found({ removed: [] }));
    expect(await prepareUpload(original, "always", ask)).toEqual({ file: original });
  });

  it("ask: asks only when something was found, keeps the file on 'keep'", async () => {
    const ask = vi.fn().mockResolvedValue(true);
    expect(await prepareUpload(original, "ask", ask)).toEqual({ file: cleaned, note: "removed" });
    expect(ask).toHaveBeenCalledWith({ kind: "metadata", found: ["exif"] });
    ask.mockResolvedValue(false);
    expect(await prepareUpload(original, "ask", ask)).toEqual({ file: original });
    inspect.mockResolvedValue(found({ removed: [] }));
    ask.mockClear();
    expect(await prepareUpload(original, "ask", ask)).toEqual({ file: original });
    expect(ask).not.toHaveBeenCalled();
  });

  it("never: leaves images alone", async () => {
    const ask = vi.fn();
    expect(await prepareUpload(original, "never", ask)).toEqual({ file: original });
    expect(strip).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("videos with a location always ask, whatever the setting", async () => {
    for (const mode of ["always", "ask", "never"] as const) {
      const r = found({ removed: [], warnings: ["video_location"], kind: "video" });
      inspect.mockResolvedValue(r);
      strip.mockResolvedValue(r);
      expect(await prepareUpload(original, mode, vi.fn().mockResolvedValue(false))).toBeNull();
      expect(await prepareUpload(original, mode, vi.fn().mockResolvedValue(true))).toEqual({ file: original });
    }
  });

  it("HEIF/AVIF: notes that nothing was removed", async () => {
    const r = found({ removed: [], warnings: ["heif_not_stripped"], kind: "heif" });
    strip.mockResolvedValue(r);
    inspect.mockResolvedValue(r);
    expect(await prepareUpload(original, "always", vi.fn())).toEqual({ file: original, note: "not_removed" });
    expect(await prepareUpload(original, "never", vi.fn())).toEqual({ file: original });
  });
});
