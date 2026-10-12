// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { backendRequest, initialKind } from "./StorageSection";

const base = { url: " https://dav.example/x/ ", username: "u", password: "", access_key: " AK ", secret_key: "", region: "", bucket: " b1 ", prefix: "", encrypt_files: true };

describe("storage form", () => {
  it("sends only the fields of the chosen kind and keeps empty secrets", () => {
    expect(backendRequest({ ...base, kind: "internal" })).toEqual({ kind: "internal" });
    expect(backendRequest({ ...base, kind: "webdav" })).toEqual({ kind: "webdav", url: "https://dav.example/x/", prefix: null, encrypt_files: true, username: "u", password: null });
    expect(backendRequest({ ...base, kind: "webdav", password: "pw" }).password).toBe("pw");
    expect(backendRequest({ ...base, kind: "s3" })).toEqual({ kind: "s3", url: "https://dav.example/x/", prefix: null, encrypt_files: true, access_key: "AK", secret_key: null, region: null, bucket: "b1" });
  });
});

describe("storage kind", () => {
  it("starts a channel without a store on an external kind (the node keeps no files, FILES.md §5)", () => {
    expect(initialKind({ kind: "none", external_allowed: true })).toBe("webdav");
    expect(initialKind({ kind: "s3", external_allowed: true })).toBe("s3");
    expect(initialKind({ kind: "internal", external_allowed: false })).toBe("internal");
  });
});
