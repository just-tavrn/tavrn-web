// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../components/ContextMenu";
import { audioRouteMenu, routeLabel } from "./audioRoutes";

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key);

describe("audioRouteMenu", () => {
  it("lists the connected outputs in the shell's order, the one in use checked", () => {
    const entries = audioRouteMenu({ available: ["speaker", "earpiece", "bluetooth"], current: "bluetooth" }, vi.fn(), t);
    expect(entries[0]).toEqual({ kind: "label", id: "label", label: "voice.route.title" });
    expect(entries.slice(1).map((e) => [e.id, (e as MenuItem).label, (e as MenuItem).checked])).toEqual([
      ["route:speaker", "voice.route.speaker", false],
      ["route:earpiece", "voice.route.earpiece", false],
      ["route:bluetooth", "voice.route.bluetooth", true],
    ]);
  });

  it("chooses a route and closes", () => {
    const choose = vi.fn();
    const entries = audioRouteMenu({ available: ["speaker", "wired"], current: "wired" }, choose, t);
    const speaker = entries.find((e) => e.id === "route:speaker") as MenuItem;
    expect(speaker.keepOpen).toBe(false);
    speaker.onSelect?.();
    expect(choose).toHaveBeenCalledWith("speaker");
  });

  it("names nothing checked before voice runs", () => {
    const entries = audioRouteMenu({ available: ["speaker"], current: null }, vi.fn(), t);
    expect((entries[1] as MenuItem).checked).toBe(false);
    expect(routeLabel("earpiece", t)).toBe("voice.route.earpiece");
  });
});
