// SPDX-License-Identifier: Apache-2.0
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { labelsHidden, unlockDeviceLabels, useMediaDevices, type DeviceSource } from "./devices";

const info = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({ kind, deviceId, label, groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;

/**
 * A fake `navigator.mediaDevices` as browsers behave: before a capture permission only the kinds without ids and
 * labels; after `getUserMedia({ audio })` the microphones and speakers with ids and labels.
 */
function fakeDevices(opts: { granted?: boolean; refuse?: boolean } = {}) {
  let granted = !!opts.granted;
  const listeners = new Set<() => void>();
  const stopped: string[] = [];
  const md = {
    enumerateDevices: vi.fn(async () =>
      granted
        ? [info("audioinput", "default", "Default"), info("audioinput", "mic-1", "USB Headset"), info("audiooutput", "spk-1", "Speakers"), info("videoinput", "", "")]
        : [info("audioinput", "", ""), info("audiooutput", "", ""), info("videoinput", "", "")],
    ),
    getUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
      if (opts.refuse) throw new DOMException("denied", "NotAllowedError");
      granted = true;
      const track = { kind: "audio", stop: () => stopped.push("audio") };
      expect(c).toEqual({ audio: true });
      return { getTracks: () => [track] } as unknown as MediaStream;
    }),
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  } satisfies DeviceSource;
  return {
    md,
    stopped,
    change: () => listeners.forEach((fn) => fn()),
    grant: () => {
      granted = true;
    },
    listeners,
  };
}

describe("device labels", () => {
  it("are hidden while the microphones or speakers have no label or id", () => {
    expect(labelsHidden([info("audioinput", "", ""), info("audiooutput", "", "")])).toBe(true);
    expect(labelsHidden([info("audioinput", "mic-1", "")])).toBe(true);
    expect(labelsHidden([info("audioinput", "mic-1", "USB Headset"), info("videoinput", "", "")])).toBe(false);
    // No devices at all: nothing to reveal.
    expect(labelsHidden([])).toBe(false);
  });

  it("a short microphone request reveals them and stops its track at once", async () => {
    const f = fakeDevices();
    await expect(unlockDeviceLabels(f.md)).resolves.toBe(true);
    expect(f.stopped).toEqual(["audio"]);
    expect(labelsHidden(await f.md.enumerateDevices())).toBe(false);
  });

  it("a refused request resolves false", async () => {
    const f = fakeDevices({ refuse: true });
    await expect(unlockDeviceLabels(f.md)).resolves.toBe(false);
    await expect(unlockDeviceLabels({ enumerateDevices: f.md.enumerateDevices })).resolves.toBe(false);
  });
});

describe("useMediaDevices", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it("desktop app: asks for the microphone when the tab opens and lists the devices without the microphone test", async () => {
    const f = fakeDevices();
    const { result } = renderHook(() => useMediaDevices({ source: f.md, autoUnlock: true }));
    await waitFor(() => expect(result.current.devices.map((d) => d.label)).toEqual(["Default", "USB Headset", "Speakers", ""]));
    expect(result.current.needsPermission).toBe(false);
    expect(f.md.getUserMedia).toHaveBeenCalledTimes(1);
    expect(f.stopped).toEqual(["audio"]);
  });

  it("desktop app: no \"Show devices\" while it asks by itself (the page would jump)", async () => {
    const f = fakeDevices();
    let grant: () => void = () => undefined;
    const ask = f.md.getUserMedia;
    f.md.getUserMedia = vi.fn((c: MediaStreamConstraints) => new Promise<MediaStream>((resolve) => (grant = () => resolve(ask(c))))) as typeof ask;
    const { result } = renderHook(() => useMediaDevices({ source: f.md, autoUnlock: true }));
    await waitFor(() => expect(f.md.getUserMedia).toHaveBeenCalledTimes(1));
    expect(result.current.devices).toHaveLength(3);
    expect(result.current.needsPermission).toBe(false);
    await act(async () => grant());
    await waitFor(() => expect(result.current.devices.some((d) => d.label === "USB Headset")).toBe(true));
  });

  it("desktop app: offers \"Show devices\" only when its own request was refused", async () => {
    const f = fakeDevices({ refuse: true });
    const { result } = renderHook(() => useMediaDevices({ source: f.md, autoUnlock: true }));
    await waitFor(() => expect(f.md.getUserMedia).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.needsPermission).toBe(true));
  });

  it("browser: does not prompt by itself; unlock() (the button or the first focus of a list) fills the lists", async () => {
    const f = fakeDevices();
    const { result } = renderHook(() => useMediaDevices({ source: f.md, autoUnlock: false }));
    await waitFor(() => expect(result.current.needsPermission).toBe(true));
    expect(f.md.getUserMedia).not.toHaveBeenCalled();
    await act(() => result.current.unlock());
    await waitFor(() => expect(result.current.devices.some((d) => d.label === "USB Headset")).toBe(true));
    expect(result.current.needsPermission).toBe(false);
    // A second unlock asks nothing again.
    await act(() => result.current.unlock());
    expect(f.md.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("browser with the permission granted earlier: labels come without any request", async () => {
    const f = fakeDevices({ granted: true });
    const { result } = renderHook(() => useMediaDevices({ source: f.md, autoUnlock: false }));
    await waitFor(() => expect(result.current.devices).toHaveLength(4));
    expect(result.current.needsPermission).toBe(false);
    expect(f.md.getUserMedia).not.toHaveBeenCalled();
  });

  it("re-enumerates on devicechange and on refresh, and stops listening when unmounted", async () => {
    const f = fakeDevices();
    const { result, rerender, unmount } = renderHook(({ refresh }) => useMediaDevices({ source: f.md, autoUnlock: false, refresh }), { initialProps: { refresh: 0 } });
    await waitFor(() => expect(result.current.needsPermission).toBe(true));
    // Another part of the page got the permission (the microphone test): the next refresh shows the labels.
    f.grant();
    rerender({ refresh: 1 });
    await waitFor(() => expect(result.current.needsPermission).toBe(false));
    const calls = f.md.enumerateDevices.mock.calls.length;
    act(() => f.change());
    await waitFor(() => expect(f.md.enumerateDevices.mock.calls.length).toBe(calls + 1));
    unmount();
    expect(f.listeners.size).toBe(0);
  });

  it("without mediaDevices: an empty list, nothing to unlock", async () => {
    const { result } = renderHook(() => useMediaDevices({ source: null, autoUnlock: true }));
    expect(result.current.devices).toEqual([]);
    expect(result.current.needsPermission).toBe(false);
    await act(() => result.current.unlock());
  });
});
