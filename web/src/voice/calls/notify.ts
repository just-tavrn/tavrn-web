// SPDX-License-Identifier: Apache-2.0
/**
 * The system notification of an incoming call in a browser (design note 4.11, VOICE.md §11.2), shown by the page
 * through its service worker when the in-page ringtone cannot be heard: the tab is hidden, or the browser blocks
 * audio until the user touches the page (mobile autoplay policies; Chromium on Android also blocks
 * `navigator.vibrate` until then). The operating system then alerts with its own sound and vibration. The tag is the
 * one of the node's call push (`<node>|<conversation id>`, `public/sw.js`), so a push of the same ring replaces it
 * silently instead of alerting twice; the page closes it when the ring ends (answered, declined, over).
 * The desktop app has native notifications instead (`lib/notify.ts`).
 */
import { RING_VIBRATION } from "../cues";

export interface CallNotice {
  tag: string;
  title: string;
  body: string;
  /** Route of the conversation (a click opens it). */
  path: string;
}

/** What is used of the service worker registration. */
export interface Registration {
  showNotification(title: string, options?: NotificationOptions): Promise<void>;
  getNotifications(filter?: GetNotificationOptions): Promise<Array<{ close(): void }>>;
}

/** Whether the ring needs a system notification on this device. */
export function callNoticeWanted(c: { hidden: boolean; soundBlocked: boolean; permission: NotificationPermission | "unsupported"; enabled: boolean }): boolean {
  return (c.hidden || c.soundBlocked) && c.permission === "granted" && c.enabled;
}

/** Shows the notification unless one with its tag is there already; returns whether it was shown. Never throws. */
export async function showCallNotice(reg: Registration | null, n: CallNotice): Promise<boolean> {
  if (!reg) return false;
  try {
    if ((await reg.getNotifications({ tag: n.tag })).length > 0) return false;
    const options: NotificationOptions & { renotify: boolean; vibrate: number[] } = {
      body: n.body,
      tag: n.tag,
      renotify: true,
      requireInteraction: true,
      vibrate: RING_VIBRATION,
      icon: "/icon-192.png",
      badge: "/icon-64.png",
      data: { url: n.path },
    };
    await reg.showNotification(n.title, options);
    return true;
  } catch {
    return false;
  }
}

/** Closes the notification of a ring that ended. Never throws. */
export async function closeCallNotice(reg: Registration | null, tag: string): Promise<void> {
  if (!reg) return;
  try {
    for (const n of await reg.getNotifications({ tag })) n.close();
  } catch {
    /* nothing to close */
  }
}
