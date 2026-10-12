// SPDX-License-Identifier: Apache-2.0
/** The Android app's back gesture, app links and system bars (`androidShell.ts`), with a fake Android side. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyInsets, canGoBack, closeTopLayer, onBackGesture, routeOrientationLock, startAndroidShell } from "./androidShell";
import { fakeAndroid } from "./androidTestPlatform";


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

/** A `screen.orientation` as Android's webview has it: `lock()` rejects (not implemented), `unlock()` does nothing. */
function webviewOrientation(lock: (o: string) => Promise<void> = async () => Promise.reject(new DOMException("lockOrientation() is not available on this device.", "NotSupportedError"))) {
  return { type: "portrait-primary", angle: 0, lock: vi.fn(lock), unlock: vi.fn(() => undefined) } as unknown as ScreenOrientation & { lock: (o: string) => Promise<void>; unlock: () => void };
}

describe("the Screen Orientation API in the app", () => {
  it("locks natively what the webview refuses, and releases that lock again", async () => {
    const android = fakeAndroid();
    const orientation = webviewOrientation();
    const stop = routeOrientationLock(android, orientation);
    await orientation.lock("landscape");
    expect(android.lockOrientation).toHaveBeenCalledWith("landscape");
    orientation.unlock();
    await vi.waitFor(() => expect(android.lockOrientation).toHaveBeenLastCalledWith(null));
    stop();
    // Stopped: the webview's own members again.
    await expect(orientation.lock("landscape")).rejects.toThrow("not available");
    expect(android.lockOrientation).toHaveBeenCalledTimes(2);
  });

  it("keeps the webview's lock where it works", async () => {
    const android = fakeAndroid();
    const orientation = webviewOrientation(async () => undefined);
    const stop = routeOrientationLock(android, orientation);
    await orientation.lock("portrait");
    orientation.unlock();
    expect(android.lockOrientation).not.toHaveBeenCalled();
    stop();
  });

  it("rejects as the standard API does when the app refuses too (not in fullscreen)", async () => {
    const android = fakeAndroid();
    vi.mocked(android.lockOrientation).mockRejectedValueOnce("orientation.refused");
    const orientation = webviewOrientation();
    const stop = routeOrientationLock(android, orientation);
    await expect(orientation.lock("landscape")).rejects.toMatchObject({ name: "NotSupportedError" });
    // Nothing was locked: unlocking does not call the app.
    orientation.unlock();
    expect(android.lockOrientation).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("the wiring", () => {
  it("follows insets and the back gesture until stopped (links: DeepLinkPrompt)", async () => {
    const android = fakeAndroid();
    const back = vi.fn();
    window.history.replaceState({ idx: 1 }, "");
    const stop = startAndroidShell({ android, back });
    expect(document.documentElement.style.getPropertyValue("--safe-top")).toBe("24px");
    android.emitInsets({ top: 30, right: 0, bottom: 0, left: 0, keyboard: 250 });
    expect(document.documentElement.style.getPropertyValue("--safe-top")).toBe("30px");
    android.emitBack();
    expect(back).toHaveBeenCalledTimes(1);
    stop();
    android.emitBack();
    expect(back).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "");
  });
});
