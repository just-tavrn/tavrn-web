// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { initialViewer, viewerReducer, MAX_ZOOM } from "./MediaViewer";

describe("viewerReducer", () => {
  it("starts at the clicked item, unzoomed", () => {
    expect(initialViewer(3, 1)).toEqual({ index: 1, count: 3, zoom: 1, x: 0, y: 0 });
    expect(initialViewer(2, 9).index).toBe(1);
  });

  it("moves between the items of the message without wrapping and resets the zoom", () => {
    let s = viewerReducer(initialViewer(3, 0), { type: "zoom", factor: 2 });
    s = viewerReducer(s, { type: "pan", dx: 10, dy: 5 });
    s = viewerReducer(s, { type: "next" });
    expect(s).toEqual({ index: 1, count: 3, zoom: 1, x: 0, y: 0 });
    s = viewerReducer(viewerReducer(s, { type: "next" }), { type: "next" });
    expect(s.index).toBe(2);
    s = viewerReducer(s, { type: "prev" });
    expect(s.index).toBe(1);
    expect(viewerReducer(initialViewer(3, 0), { type: "prev" }).index).toBe(0);
  });

  it("clamps the zoom and centers again at 1×", () => {
    let s = initialViewer(1, 0);
    for (let i = 0; i < 20; i++) s = viewerReducer(s, { type: "zoom", factor: 1.5 });
    expect(s.zoom).toBe(MAX_ZOOM);
    s = viewerReducer(s, { type: "pan", dx: 40, dy: -20 });
    expect(s).toMatchObject({ x: 40, y: -20 });
    s = viewerReducer(s, { type: "set-zoom", zoom: 0.2 });
    expect(s).toMatchObject({ zoom: 1, x: 0, y: 0 });
  });

  it("pans only while zoomed; double-click toggles 1× and 2×", () => {
    let s = viewerReducer(initialViewer(1, 0), { type: "pan", dx: 50, dy: 50 });
    expect(s).toMatchObject({ x: 0, y: 0 });
    s = viewerReducer(s, { type: "toggle-zoom" });
    expect(s.zoom).toBe(2);
    s = viewerReducer(s, { type: "toggle-zoom" });
    expect(s.zoom).toBe(1);
  });

  it("scales the pan with the zoom", () => {
    let s = viewerReducer(initialViewer(1, 0), { type: "set-zoom", zoom: 2 });
    s = viewerReducer(s, { type: "pan", dx: 100, dy: 0 });
    s = viewerReducer(s, { type: "set-zoom", zoom: 4 });
    expect(s.x).toBe(200);
  });
});
