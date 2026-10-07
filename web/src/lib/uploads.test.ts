// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { acceptFor, classifyName, declaredCategory, extensionOf, isAllowed } from "./uploads";

describe("upload categories (PROTOCOL.md §7a)", () => {
  it("classifies by extension and type like the node", () => {
    expect(classifyName("photo.PNG", "")).toEqual({ category: "images", executable: false });
    expect(classifyName("song", "audio/ogg")).toEqual({ category: "audio", executable: false });
    expect(classifyName("clip.webm", "")).toEqual({ category: "video", executable: false });
    expect(classifyName("rules.pdf", "application/pdf")).toEqual({ category: "documents", executable: false });
    expect(classifyName("notes", "text/plain")).toEqual({ category: "documents", executable: false });
    expect(classifyName("mod.tar.gz", "")).toEqual({ category: "archives", executable: false });
    expect(classifyName("level.sav", "application/octet-stream")).toEqual({ category: "other", executable: false });
  });

  it("SVG is a document, never an image (design note 4.12)", () => {
    expect(classifyName("logo.svg", "image/svg+xml")).toEqual({ category: "documents", executable: false });
    expect(classifyName("logo", "image/svg+xml")).toEqual({ category: "documents", executable: false });
    expect(classifyName("logo.SVGZ", "")).toEqual({ category: "documents", executable: false });
  });

  it("flags executables by extension, type and magic bytes", () => {
    for (const name of ["setup.exe", "x.msi", "run.sh", "a.bat", "b.ps1", "app.jar", "app.apk", "disk.dmg", "x.iso", "lnk.lnk", "trailing.exe. "]) {
      expect(classifyName(name, "").executable, name).toBe(true);
    }
    expect(classifyName("x.bin", "application/x-msdownload").executable).toBe(true);
    expect(classifyName("photo.png", "image/png", new Uint8Array([0x4d, 0x5a, 0x90]))).toEqual({ category: "other", executable: true });
    expect(classifyName("photo.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])).executable).toBe(false);
    expect(declaredCategory({ category: "other", executable: true })).toBe("executable");
    expect(declaredCategory({ category: "images", executable: false })).toBe("images");
  });

  it("checks the policy and builds the picker filter", () => {
    expect(isAllowed({ category: "images", executable: false }, ["images"], false)).toBe(true);
    expect(isAllowed({ category: "documents", executable: false }, ["images"], false)).toBe(false);
    expect(isAllowed({ category: "other", executable: true }, ["other"], false)).toBe(false);
    expect(isAllowed({ category: "other", executable: true }, ["other"], true)).toBe(true);
    expect(acceptFor(["images", "other"])).toBe("");
    const accept = acceptFor(["images", "archives"]).split(",");
    expect(accept).toContain("image/*");
    expect(accept).toContain(".zip");
    expect(accept).not.toContain("application/pdf");
    expect(extensionOf(".bashrc")).toBe("");
  });
});
