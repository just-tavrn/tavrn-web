// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DANGEROUS_EXTENSIONS, acceptFor, classifyName, declaredCategory, executableKind, extensionOf, isAllowed, isExecutable, readHead } from "./uploads";

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

const bytes = (...b: (number | string)[]) => new Uint8Array(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
const at = (offset: number, ...b: (number | string)[]) => {
  const tail = bytes(...b);
  const out = new Uint8Array(offset + tail.length);
  out.set(tail, offset);
  return out;
};

describe("executables before a download (the node's rules, uploads.rs)", () => {
  it.each([
    // [name, type, head, kind]
    ["setup.exe", "", undefined, "windows"],
    ["photo.png", "image/png", bytes("MZ", 0x90, 0), "windows"],
    ["tool", "", bytes(0x7f, "ELF", 2), "linux"],
    ["tool", "", bytes(0xcf, 0xfa, 0xed, 0xfe), "macos"],
    ["tool", "", bytes(0xfe, 0xed, 0xfa, 0xce), "macos"],
    ["tool", "", bytes(0xfe, 0xed, 0xfa, 0xcf), "macos"],
    ["tool", "", bytes(0xce, 0xfa, 0xed, 0xfe), "macos"],
    ["Main.class", "", bytes(0xca, 0xfe, 0xba, 0xbe), "java"],
    ["classes", "", bytes("dex\n035"), "mobile_app"],
    ["run.txt", "text/plain", bytes("#!/bin/sh\n"), "script"],
    ["link", "", bytes("L", 0, 0, 0, 1, 0x14, 2, 0), "shortcut"],
    ["disk", "", at(0x8001, "CD001"), "disk_image"],
    ["disk", "", bytes("koly"), "disk_image"],
    ["x.bat", "", undefined, "script"],
    ["x.PS1", "", undefined, "script"],
    ["x.js", "", undefined, "script"],
    ["app.jar", "", bytes("PK", 3, 4), "java"],
    ["app.apk", "", bytes("PK", 3, 4), "mobile_app"],
    ["x.msi", "", undefined, "installer"],
    ["x.deb", "", undefined, "installer"],
    ["x.dmg", "", undefined, "disk_image"],
    ["x.iso", "", undefined, "disk_image"],
    ["x.lnk", "", undefined, "shortcut"],
    ["report.docm", "", bytes("PK", 3, 4), "macro_document"],
    ["x.dll", "", undefined, "library"],
    ["trailing.exe. ", "", undefined, "windows"],
    ["x.dat", "application/x-msdownload", undefined, "windows"],
    ["x.dat", "text/javascript; charset=utf-8", undefined, "script"],
    ["x.dat", "application/x-apple-diskimage", undefined, "disk_image"],
  ] as const)("%s (%s) is %s", (name, type, head, kind) => {
    expect(executableKind(name, type, head)).toBe(kind);
    expect(isExecutable(name, type, head)).toBe(true);
  });

  it.each([
    ["mod.zip", "application/zip", bytes("PK", 3, 4)],
    ["save.tar.gz", "application/gzip", bytes(0x1f, 0x8b, 8)],
    ["pack.7z", "", bytes("7z", 0xbc, 0xaf, 0x27, 0x1c)],
    ["pack.rar", "", bytes("Rar!", 0x1a, 7)],
    ["pack.tar.xz", "", bytes(0xfd, "7zXZ", 0)],
    ["pack.tar", "", at(257, "ustar")],
    ["report.docx", "", bytes("PK", 3, 4)],
    ["photo.png", "image/png", bytes(0x89, "PNG\r\n", 0x1a, "\n")],
    ["notes.txt", "text/plain", bytes("hello")],
    ["level.sav", "application/octet-stream", bytes("whatever")],
    ["", "", undefined],
  ] as const)("%s is not warned (archives are excluded by the owner)", (name, type, head) => {
    expect(executableKind(name, type, head)).toBeNull();
    expect(isExecutable(name, type, head)).toBe(false);
  });

  it("every dangerous extension of the node has a kind", () => {
    for (const ext of DANGEROUS_EXTENSIONS) expect(executableKind(`f.${ext}`, ""), ext).not.toBeNull();
    expect(executableKind("f.constructor", "")).toBeNull();
  });

  it("uploads use the same magic bytes (dex, every Mach-O, shortcuts)", () => {
    expect(classifyName("a.png", "image/png", bytes("dex\n035")).executable).toBe(true);
    expect(classifyName("a.png", "image/png", bytes(0xfe, 0xed, 0xfa, 0xcf)).executable).toBe(true);
    expect(classifyName("a.png", "image/png", bytes("L", 0, 0, 0, 1, 0x14, 2, 0)).executable).toBe(true);
  });

  it("reads enough of a blob for every magic number (disk images at 32 KiB)", async () => {
    const head = await readHead(new Blob([at(0x9001, "CD001"), new Uint8Array(100_000)]));
    expect(executableKind("disk", "", head)).toBe("disk_image");
    expect(head.length).toBeLessThan(100_000);
    expect(await readHead(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
