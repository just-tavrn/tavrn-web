// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { announceUpdate } from "./updates";
import type { Platform } from "./types";

const base: Platform = {
  kind: "desktop",
  isDesktop: true,
  nodeBase: () => "https://tavrn.example",
  webOrigin: () => "https://tavrn.example",
  openExternal: async () => {},
  appVersion: async () => "0.2.0",
};

describe("announceUpdate", () => {
  it("announces a newer version with a link to the app settings", async () => {
    const toast = vi.fn();
    await announceUpdate({ ...base, updater: { check: async () => ({ version: "0.3.0", install: async () => {} }) } }, toast);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "info", path: "/settings/app" }));
    expect(toast.mock.calls[0]![0].title).toContain("0.3.0");
  });

  it("stays quiet without an update, without an updater and when the check fails", async () => {
    const toast = vi.fn();
    await announceUpdate({ ...base, updater: { check: async () => null } }, toast);
    await announceUpdate(base, toast);
    await announceUpdate({ ...base, updater: { check: () => Promise.reject(new Error("offline")) } }, toast);
    expect(toast).not.toHaveBeenCalled();
  });
});
