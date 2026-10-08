// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPlatform } from "./browser";

afterEach(() => vi.restoreAllMocks());

describe("browserPlatform", () => {
  it("keeps today's behaviour: same origin, no desktop features", async () => {
    expect(browserPlatform.kind).toBe("browser");
    expect(browserPlatform.isDesktop).toBe(false);
    expect(browserPlatform.nodeBase()).toBe("");
    expect(browserPlatform.webOrigin()).toBe(location.origin);
    expect(browserPlatform.node).toBeUndefined();
    expect(browserPlatform.updater).toBeUndefined();
    expect(browserPlatform.hotkeys).toBeUndefined();
    expect(browserPlatform.keystore).toBeUndefined();
    expect(browserPlatform.notifications).toBeUndefined();
    expect(browserPlatform.tray).toBeUndefined();
    await expect(browserPlatform.appVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/);
  });

  it("opens external links in a new tab without access to this window", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await browserPlatform.openExternal("https://example.org/page");
    expect(open).toHaveBeenCalledWith("https://example.org/page", "_blank", "noopener,noreferrer");
  });

  it("refuses links that are not http(s)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await expect(browserPlatform.openExternal("javascript:alert(1)")).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
});
