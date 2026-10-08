// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, useVoiceSettings } from "./settings";
import { IDLE, useVoice, type VoiceStatus } from "./store";
import { startWakeLock, type WakeLockEnv } from "./wakeLock";

/** A fake Screen Wake Lock API: every request hands out a sentinel the test can inspect or release like the browser. */
function fakeWakeLock(opts: { reject?: unknown } = {}) {
  const sentinels: Array<EventTarget & { released: boolean; type: "screen"; release: () => Promise<void>; browserRelease: () => void }> = [];
  const wakeLock = {
    request: vi.fn(async (type: "screen") => {
      if (opts.reject) throw opts.reject;
      const target = new EventTarget();
      const sentinel = Object.assign(target, {
        released: false,
        type,
        release: vi.fn(async () => {
          if (sentinel.released) return;
          sentinel.released = true;
          sentinel.dispatchEvent(new Event("release"));
        }),
        // What the browser does when the page is hidden.
        browserRelease: () => {
          sentinel.released = true;
          sentinel.dispatchEvent(new Event("release"));
        },
      });
      sentinels.push(sentinel);
      return sentinel;
    }),
  };
  const held = () => sentinels.filter((s) => !s.released).length;
  return { wakeLock, sentinels, held };
}

/** A document whose visibility the test switches. */
function fakeDocument() {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const setVisible = (visible: boolean) => {
    doc.visibilityState = visible ? "visible" : "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { doc, setVisible };
}

const status = (s: VoiceStatus, call = false) => useVoice.setState({ status: s, target: s === "idle" ? null : { domain: "a.test", roomId: call ? "" : "r1", channelId: "c1", call } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("screen wake lock while in a voice call", () => {
  let stop: (() => void) | null = null;
  const start = (env: WakeLockEnv) => (stop = startWakeLock(env));

  beforeEach(() => {
    useVoice.setState(IDLE);
    useVoiceSettings.setState({ settings: DEFAULT_SETTINGS });
  });
  afterEach(() => {
    stop?.();
    stop = null;
    vi.restoreAllMocks();
  });

  it("is on by default", () => {
    expect(DEFAULT_SETTINGS.keepScreenOn).toBe(true);
  });

  it("acquires the lock once connected (voice channel) and releases it on leave", async () => {
    const { wakeLock, held } = fakeWakeLock();
    start({ wakeLock, document: fakeDocument().doc, desktop: false });
    status("joining");
    await flush();
    expect(wakeLock.request).not.toHaveBeenCalled();
    status("connected");
    await flush();
    expect(wakeLock.request).toHaveBeenCalledWith("screen");
    expect(held()).toBe(1);
    // Reconnecting is still the same call: the lock stays.
    status("reconnecting");
    await flush();
    status("connected");
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    status("idle");
    await flush();
    expect(held()).toBe(0);
  });

  it("acquires the lock in a DM call as well", async () => {
    const { wakeLock, held } = fakeWakeLock();
    start({ wakeLock, document: fakeDocument().doc, desktop: false });
    status("connected", true);
    await flush();
    expect(held()).toBe(1);
  });

  it("re-acquires the lock when the page becomes visible again after the browser released it", async () => {
    const { wakeLock, sentinels, held } = fakeWakeLock();
    const { doc, setVisible } = fakeDocument();
    start({ wakeLock, document: doc, desktop: false });
    status("connected");
    await flush();
    sentinels[0]!.browserRelease();
    setVisible(false);
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    setVisible(true);
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(held()).toBe(1);
  });

  it("does not request while the page is hidden", async () => {
    const { wakeLock } = fakeWakeLock();
    const { doc } = fakeDocument();
    doc.visibilityState = "hidden";
    start({ wakeLock, document: doc, desktop: false });
    status("connected");
    await flush();
    expect(wakeLock.request).not.toHaveBeenCalled();
  });

  it("respects the setting: off releases the lock, on acquires it again, off from the start never requests", async () => {
    const { wakeLock, held } = fakeWakeLock();
    start({ wakeLock, document: fakeDocument().doc, desktop: false });
    status("connected");
    await flush();
    expect(held()).toBe(1);
    useVoiceSettings.getState().update({ keepScreenOn: false });
    await flush();
    expect(held()).toBe(0);
    useVoiceSettings.getState().update({ keepScreenOn: true });
    await flush();
    expect(held()).toBe(1);

    stop?.();
    status("idle");
    const other = fakeWakeLock();
    useVoiceSettings.getState().update({ keepScreenOn: false });
    start({ wakeLock: other.wakeLock, document: fakeDocument().doc, desktop: false });
    status("connected");
    await flush();
    expect(other.wakeLock.request).not.toHaveBeenCalled();
  });

  it("releases a lock that arrives after the call already ended", async () => {
    let grant: (s: unknown) => void = () => undefined;
    const sentinel = Object.assign(new EventTarget(), { released: false, type: "screen" as const, release: vi.fn(async () => undefined) });
    const wakeLock = { request: vi.fn(() => new Promise((r) => (grant = r))) };
    start({ wakeLock: wakeLock as unknown as WakeLockEnv["wakeLock"], document: fakeDocument().doc, desktop: false });
    status("connected");
    status("idle");
    grant(sentinel);
    await flush();
    expect(sentinel.release).toHaveBeenCalled();
  });

  it("is a no-op without the API", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    start({ wakeLock: undefined, document: fakeDocument().doc, desktop: false });
    status("connected");
    await flush();
    status("idle");
    await flush();
    expect(debug).not.toHaveBeenCalled();
  });

  it("swallows a rejected request with one debug log and no toast", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { wakeLock } = fakeWakeLock({ reject: new DOMException("denied", "NotAllowedError") });
    const { doc, setVisible } = fakeDocument();
    start({ wakeLock, document: doc, desktop: false });
    status("connected");
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(1);
    // A later attempt (the page visible again) may try once more; still nothing but the debug log.
    setVisible(false);
    setVisible(true);
    await flush();
    expect(debug.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("does nothing in the desktop app (the shell will inhibit system sleep)", async () => {
    const { wakeLock } = fakeWakeLock();
    start({ wakeLock, document: fakeDocument().doc, desktop: true });
    status("connected");
    await flush();
    expect(wakeLock.request).not.toHaveBeenCalled();
  });

  it("releases the lock when stopped", async () => {
    const { wakeLock, held } = fakeWakeLock();
    start({ wakeLock, document: fakeDocument().doc, desktop: false });
    status("connected");
    await flush();
    stop?.();
    stop = null;
    await flush();
    expect(held()).toBe(0);
  });
});
