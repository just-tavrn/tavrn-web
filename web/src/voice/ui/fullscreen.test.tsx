// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { enterFullscreen, exitFullscreen, fullscreenElement, toggleFullscreen, useFullscreen, useFullscreenShortcut, FullscreenButton } from "./fullscreen";

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
    <div ref={fs.ref} data-testid="frame" data-active={fs.active || undefined}>
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
