// SPDX-License-Identifier: Apache-2.0
/** The Android app's back gesture, app links and system bars (`androidShell.ts`), with a fake Android side. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyInsets, canGoBack, closeTopLayer, linkRoute, onBackGesture, startAndroidShell } from "./androidShell";
import { fakeAndroid } from "./androidTestPlatform";

const home = { web: "https://app.tavrn.example", domain: "tavrn.example" };

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
});

describe("the back gesture", () => {
  it("closes the open dialog first", () => {
    document.body.innerHTML = '<div role="dialog" id="d"><button id="b">x</button></div>';
    const seen = vi.fn();
    document.getElementById("d")?.addEventListener("keydown", (e) => seen(e.key));
    document.getElementById("b")?.focus();
    const android = fakeAndroid();
    const back = vi.fn();
    expect(onBackGesture(android, { back }, document, { state: { idx: 3 } })).toBe("layer");
    expect(seen).toHaveBeenCalledWith("Escape");
    expect(back).not.toHaveBeenCalled();
    expect(android.background).not.toHaveBeenCalled();
  });

  it("closes an open drawer by its closer", () => {
    document.body.innerHTML = '<button data-back-close="" id="c">close</button>';
    const clicked = vi.fn();
    document.getElementById("c")?.addEventListener("click", clicked);
    expect(onBackGesture(fakeAndroid(), { back: vi.fn() }, document, { state: { idx: 0 } })).toBe("layer");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("goes back in the client's history, and from the first page sends the app to the background", () => {
    const android = fakeAndroid();
    const back = vi.fn();
    expect(onBackGesture(android, { back }, document, { state: { idx: 2 } })).toBe("back");
    expect(back).toHaveBeenCalledTimes(1);
    expect(onBackGesture(android, { back }, document, { state: { idx: 0 } })).toBe("background");
    expect(onBackGesture(android, { back }, document, { state: null })).toBe("background");
    expect(android.background).toHaveBeenCalledTimes(2);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("knows react-router's history index", () => {
    expect(canGoBack({ state: { idx: 1 } })).toBe(true);
    expect(canGoBack({ state: { idx: 0 } })).toBe(false);
    expect(canGoBack({ state: { idx: "1" } })).toBe(false);
    expect(closeTopLayer(document)).toBe(false);
  });
});

describe("app links", () => {
  it("routes the home node's links as they are", async () => {
    const identity = vi.fn(async () => "other");
    expect(await linkRoute("https://app.tavrn.example/invite/Code_1234", home, identity)).toBe("/invite/Code_1234");
    expect(await linkRoute("https://app.tavrn.example/add/01ABC?room=tavrn.example%2F01R", home, identity)).toBe("/add/01ABC?room=tavrn.example%2F01R");
    expect(identity).not.toHaveBeenCalled();
  });

  it("names another node by its identity domain", async () => {
    const identity = vi.fn(async (host: string) => (host === "app.other.example" ? "other.example" : null));
    expect(await linkRoute("https://app.other.example/invite/Code_1234", home, identity)).toBe("/invite/Code_1234?node=other.example");
    expect(await linkRoute("https://app.other.example/add/01ABC", home, identity)).toBe("/add/other.example/01ABC");
    expect(await linkRoute("https://chat.example/add/third.example/01ABC", home, identity)).toBe("/add/third.example/01ABC");
    // Unknown identity (offline): the host itself.
    expect(await linkRoute("https://chat.example/invite/Code_1234", home, async () => null)).toBe("/invite/Code_1234?node=chat.example");
    // A delegated host of the home node itself.
    expect(await linkRoute("https://web.tavrn.example/invite/Code_1234", home, async () => "tavrn.example")).toBe("/invite/Code_1234");
  });

  it("ignores everything else", async () => {
    const identity = async () => null;
    for (const bad of ["https://app.tavrn.example/settings", "https://app.tavrn.example/invite/x", "not a url", "https://app.tavrn.example/add"]) {
      expect(await linkRoute(bad, home, identity)).toBeNull();
    }
  });
});

describe("system bars", () => {
  it("become CSS variables of the root element", () => {
    applyInsets({ top: 24.5, right: 0, bottom: 48, left: -3, keyboard: 300 });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--safe-top")).toBe("24.5px");
    expect(style.getPropertyValue("--safe-bottom")).toBe("48px");
    expect(style.getPropertyValue("--safe-left")).toBe("0px");
    expect(style.getPropertyValue("--keyboard")).toBe("300px");
  });
});

describe("the wiring", () => {
  it("follows insets, the back gesture and links until stopped", async () => {
    const android = fakeAndroid();
    const navigate = vi.fn();
    const back = vi.fn();
    window.history.replaceState({ idx: 1 }, "");
    const stop = startAndroidShell({ android, navigate, back, home: () => home });
    expect(document.documentElement.style.getPropertyValue("--safe-top")).toBe("24px");
    android.emitInsets({ top: 30, right: 0, bottom: 0, left: 0, keyboard: 250 });
    expect(document.documentElement.style.getPropertyValue("--safe-top")).toBe("30px");
    android.emitBack();
    expect(back).toHaveBeenCalledTimes(1);
    android.emitLink("https://app.tavrn.example/invite/Code_1234");
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/invite/Code_1234"));
    stop();
    android.emitBack();
    expect(back).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "");
  });
});
