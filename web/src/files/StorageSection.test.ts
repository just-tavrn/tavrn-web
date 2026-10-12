// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { backendRequest, initialKind, limitText, parseLimit } from "./StorageSection";

const base = { url: " https://dav.example/x/ ", username: "u", password: "", access_key: " AK ", secret_key: "", region: "", bucket: " b1 ", prefix: "", encrypt_files: true, limit: "" };

describe("storage form", () => {
  it("sends only the fields of the chosen kind and keeps empty secrets", () => {
    expect(backendRequest({ ...base, kind: "internal" })).toEqual({ kind: "internal" });
    expect(backendRequest({ ...base, kind: "webdav" })).toEqual({ kind: "webdav", url: "https://dav.example/x/", prefix: null, encrypt_files: true, max_bytes: 0, username: "u", password: null });
    expect(backendRequest({ ...base, kind: "webdav", password: "pw" }).password).toBe("pw");
    expect(backendRequest({ ...base, kind: "s3" })).toEqual({ kind: "s3", url: "https://dav.example/x/", prefix: null, encrypt_files: true, max_bytes: 0, access_key: "AK", secret_key: null, region: null, bucket: "b1" });
  });
});

describe("storage kind", () => {
  it("starts a channel without a store on an external kind (the node keeps no files, FILES.md §5)", () => {
    expect(initialKind({ kind: "none", external_allowed: true })).toBe("webdav");
    expect(initialKind({ kind: "s3", external_allowed: true })).toBe("s3");
    expect(initialKind({ kind: "internal", external_allowed: false })).toBe("internal");
  });
});

describe("limit on the external store (FILES.md §5)", () => {
  it("reads gigabytes, empty or 0 meaning unlimited, and refuses the rest", () => {
    expect(parseLimit("")).toBe(0);
    expect(parseLimit(" 0 ")).toBe(0);
    expect(parseLimit("50")).toBe(50 * 1024 ** 3);
    expect(parseLimit("1,5")).toBe(1.5 * 1024 ** 3);
    expect(parseLimit("0.5")).toBe(512 * 1024 ** 2);
    expect(parseLimit("-1")).toBeNull();
    expect(parseLimit("viel")).toBeNull();
    expect(parseLimit("2000000")).toBeNull();
  });

  it("shows the stored limit in gigabytes and sends it with an external store only", () => {
    expect(limitText(0)).toBe("");
    expect(limitText(50 * 1024 ** 3)).toBe("50");
    expect(limitText(1.5 * 1024 ** 3)).toBe("1.5");
    expect(backendRequest({ ...base, kind: "webdav", limit: "2" }).max_bytes).toBe(2 * 1024 ** 3);
    expect(backendRequest({ ...base, kind: "internal", limit: "2" })).toEqual({ kind: "internal" });
  });
});
