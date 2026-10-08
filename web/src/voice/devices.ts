// SPDX-License-Identifier: Apache-2.0
/**
 * The device lists of Settings → Voice & video. Browsers hide the ids and names of the microphones and speakers
 * (`enumerateDevices()` returns one nameless entry per kind) until the page holds a capture permission, so the lists
 * showed only "System default" until the microphone test ran. The desktop app's main window has the microphone
 * permission without a prompt: it asks for the microphone once when the tab opens, stops the track at once and lists
 * again. The browser does not prompt by itself: the tab offers "Show devices", and the first focus of a list does the
 * same. Every `devicechange` lists again.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The parts of `navigator.mediaDevices` used here (a fake in tests). */
export interface DeviceSource {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
  addEventListener?(type: "devicechange", listener: () => void): void;
  removeEventListener?(type: "devicechange", listener: () => void): void;
}

/** Whether the microphones or speakers are listed without their ids or names (no capture permission yet). */
export function labelsHidden(devices: MediaDeviceInfo[]): boolean {
  return devices.some((d) => (d.kind === "audioinput" || d.kind === "audiooutput") && (!d.deviceId || !d.label));
}

/** Asks for the microphone and stops the track at once; resolves whether the permission was granted. */
export async function unlockDeviceLabels(md: DeviceSource): Promise<boolean> {
  if (!md.getUserMedia) return false;
  try {
    const stream = await md.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

const browserSource = (): DeviceSource | null => (typeof navigator !== "undefined" && typeof navigator.mediaDevices?.enumerateDevices === "function" ? navigator.mediaDevices : null);

export interface MediaDevices {
  /** Every device of every kind, as the browser lists them. */
  devices: MediaDeviceInfo[];
  /** The microphones and speakers have no names yet: the tab offers "Show devices". */
  needsPermission: boolean;
  /** Asks for the microphone once (a button, the first focus of a list) and lists again. */
  unlock: () => Promise<void>;
}

/**
 * The devices for the settings: listed when the tab opens, again on `devicechange` and whenever `refresh` changes (the
 * microphone test got the permission). `autoUnlock` (the desktop app) asks for the microphone by itself.
 */
export function useMediaDevices({ source = browserSource(), autoUnlock, refresh = 0 }: { source?: DeviceSource | null; autoUnlock: boolean; refresh?: number }): MediaDevices {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const asked = useRef(false);
  const md = useRef(source);
  md.current = source;

  const list = useCallback(async () => {
    const m = md.current;
    if (!m) return [];
    const all = await m.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    setDevices(all);
    return all;
  }, []);

  const unlock = useCallback(async () => {
    const m = md.current;
    if (!m || asked.current) return;
    asked.current = true;
    if (await unlockDeviceLabels(m)) await list();
  }, [list]);

  const hasSource = !!source;
  useEffect(() => {
    const m = md.current;
    if (!m) return;
    let live = true;
    void list().then((all) => {
      if (live && autoUnlock && labelsHidden(all)) void unlock();
    });
    const changed = () => void list();
    m.addEventListener?.("devicechange", changed);
    return () => {
      live = false;
      m.removeEventListener?.("devicechange", changed);
    };
  }, [hasSource, autoUnlock, refresh, list, unlock]);

  return { devices, needsPermission: labelsHidden(devices), unlock };
}
