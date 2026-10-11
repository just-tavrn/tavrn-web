// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { enterFullscreen, exitFullscreen, fullscreenElement, toggleFullscreen, useFullscreen, useFullscreenShortcut, useHeldInFullscreen, FullscreenButton } from "./fullscreen";

const originalMatchMedia = window.matchMedia;

/** jsdom has no Fullscreen API: a minimal one on the document and on elements. */
function installFullscreenApi() {
  let current: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => current });
  const request = vi.fn(async function (this: Element) {
    current = this;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  const exit = vi.fn(async () => {
    current = null;
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = request;
  (document as unknown as { exitFullscreen: unknown }).exitFullscreen = exit;
  return { request, exit };
}

function uninstall() {
  delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
}

function Frame({ pick }: { pick?: boolean }) {
  const fs = useFullscreen<HTMLDivElement>();
  useFullscreenShortcut(() => (pick ? fs.ref.current : null));
  return (
    <div ref={fs.ref} data-testid="frame" data-active={fs.active || undefined} data-orientation={fs.active ? fs.orientation : undefined}>
      <FullscreenButton active={fs.active} onToggle={fs.toggle} />
      <input aria-label="text" />
    </div>
  );
}

describe("fullscreen (polish round 2)", () => {
  afterEach(uninstall);

  it("enters and leaves fullscreen through the Fullscreen API", async () => {
    const api = installFullscreenApi();
    const el = document.createElement("div");
    expect(await enterFullscreen(el)).toBe(true);
    expect(api.request).toHaveBeenCalledWith({ navigationUI: "hide" });
    expect(fullscreenElement()).toBe(el);
    await toggleFullscreen(el);
    expect(api.exit).toHaveBeenCalled();
    expect(fullscreenElement()).toBeNull();
  });

  it("falls back to the native video fullscreen (iOS) and reports a refusal", async () => {
    uninstall();
    const el = document.createElement("div");
    const video = document.createElement("video") as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    video.webkitEnterFullscreen = vi.fn();
    el.append(video);
    expect(await enterFullscreen(el)).toBe(true);
    expect(video.webkitEnterFullscreen).toHaveBeenCalled();
    expect(await enterFullscreen(document.createElement("div"))).toBe(false);
    (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = () => Promise.reject(new Error("not allowed"));
    expect(await enterFullscreen(document.createElement("div"))).toBe(false);
    await exitFullscreen();
  });

  it("the button toggles its element; F toggles, Escape leaves, typing is ignored", async () => {
    installFullscreenApi();
    render(<Frame pick />);
    const frame = screen.getByTestId("frame");
    await act(async () => screen.getByRole("button", { name: "Vollbild" }).click());
    expect(fullscreenElement()).toBe(frame);
    expect(frame).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: "Vollbild beenden" })).toBeInTheDocument();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(fullscreenElement()).toBeNull();
    expect(frame).not.toHaveAttribute("data-active");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" })));
    expect(fullscreenElement()).toBe(frame);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F" })));
    expect(fullscreenElement()).toBeNull();
    // In a text field `f` is just a letter; with a modifier it is someone else's shortcut.
    const input = screen.getByLabelText("text");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
    expect(fullscreenElement()).toBeNull();
  });
});

/** A touch device (`pointer: coarse`) or not; the Screen Orientation API with spies (absent in jsdom). */
function device(touch: boolean, opts: { lock?: (o: string) => Promise<void> } = {}) {
  window.matchMedia = ((query: string) => ({ ...originalMatchMedia(query), matches: touch && query === "(pointer: coarse)" })) as typeof window.matchMedia;
  const orientation = { type: "portrait-primary", lock: vi.fn(opts.lock ?? (async () => undefined)), unlock: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(window.screen, "orientation", { configurable: true, value: orientation });
  return orientation;
}

/** A tile with a video of the given size (jsdom reports 0 × 0). */
function tileWithVideo(width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  el.append(video);
  document.body.append(el);
  return el;
}

function resizeTo(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

describe("fullscreen on phones follows the orientation", () => {
  afterEach(() => {
    uninstall();
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window.screen, "orientation", { configurable: true, value: undefined });
    document.body.replaceChildren();
  });

  it("a wide stream turns a touch device to landscape, and the lock ends with fullscreen", async () => {
    installFullscreenApi();
    const orientation = device(true);
    const el = tileWithVideo(1920, 1080);
    expect(await enterFullscreen(el)).toBe(true);
    expect(orientation.lock).toHaveBeenCalledWith("landscape");
    await exitFullscreen();
    expect(orientation.unlock).toHaveBeenCalled();
  });

  it("leaving fullscreen another way (the system's back gesture) unlocks too", async () => {
    const api = installFullscreenApi();
    const orientation = device(true);
    await enterFullscreen(tileWithVideo(1280, 720));
    // The browser leaves fullscreen by itself: only the event arrives.
    await (api.exit as unknown as () => Promise<void>)();
    expect(orientation.unlock).toHaveBeenCalled();
  });

  it("no lock for a tall video, without a video or on a desktop", async () => {
    installFullscreenApi();
    let orientation = device(true);
    await enterFullscreen(tileWithVideo(720, 1280));
    await enterFullscreen(document.createElement("div"));
    expect(orientation.lock).not.toHaveBeenCalled();
    orientation = device(false);
    await enterFullscreen(tileWithVideo(1920, 1080));
    expect(orientation.lock).not.toHaveBeenCalled();
  });

  it("a refused lock (iOS Safari has none, a browser may say no) still gives fullscreen", async () => {
    installFullscreenApi();
    const orientation = device(true, { lock: () => Promise.reject(new DOMException("not supported", "NotSupportedError")) });
    const el = tileWithVideo(1920, 1080);
    expect(await enterFullscreen(el)).toBe(true);
    expect(orientation.lock).toHaveBeenCalled();
    expect(fullscreenElement()).toBe(el);
    // Without the Screen Orientation API at all: fullscreen as before.
    Object.defineProperty(window.screen, "orientation", { configurable: true, value: undefined });
    await exitFullscreen();
    expect(await enterFullscreen(tileWithVideo(1920, 1080))).toBe(true);
  });

  it("the fullscreen element knows the orientation and follows a rotation", async () => {
    installFullscreenApi();
    device(true);
    resizeTo(412, 915);
    render(<Frame />);
    const frame = screen.getByTestId("frame");
    await act(async () => screen.getByRole("button", { name: "Vollbild" }).click());
    expect(frame).toHaveAttribute("data-orientation", "portrait");
    await act(async () => resizeTo(915, 412));
    expect(frame).toHaveAttribute("data-orientation", "landscape");
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 412 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 915 });
      window.dispatchEvent(new Event("orientationchange"));
    });
    expect(frame).toHaveAttribute("data-orientation", "portrait");
  });

  it("the layout is held while something is in fullscreen (turning a phone must not remount the stream)", async () => {
    installFullscreenApi();
    function Layout({ phone }: { phone: boolean }) {
      const held = useHeldInFullscreen(phone);
      return <p data-testid="layout">{held ? "phone" : "grid"}</p>;
    }
    const view = render(<Layout phone />);
    view.rerender(<Layout phone={false} />);
    expect(screen.getByTestId("layout")).toHaveTextContent("grid");
    view.rerender(<Layout phone />);
    await act(async () => void (await enterFullscreen(document.createElement("div"))));
    // Turned to landscape: wider than the phone breakpoint, but the stage keeps its layout.
    view.rerender(<Layout phone={false} />);
    expect(screen.getByTestId("layout")).toHaveTextContent("phone");
    // Fullscreen ends: the current layout applies.
    await act(async () => exitFullscreen());
    expect(screen.getByTestId("layout")).toHaveTextContent("grid");
  });
});
