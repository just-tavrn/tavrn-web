// SPDX-License-Identifier: Apache-2.0
/**
 * "Keep a connection for notifications" of the Android app (docs/ANDROID.md): without a UnifiedPush distributor, a
 * foreground service keeps the app and its WebSocket running in the background, and the client shows its own
 * notifications natively. The switch is per device (`localStorage`); the app starts the service again at sign-in.
 */
import { t } from "../i18n";
import type { PlatformAndroid } from "../platform";

const KEY = "tavrn.android.keepConnection";

export function keepConnectionWanted(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

/** Turns the service on or off and remembers the choice. */
export async function setKeepConnection(android: Pick<PlatformAndroid, "keepConnection">, on: boolean): Promise<void> {
  await android.keepConnection(on, { title: t("android.keep.title"), text: t("android.keep.text") });
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: the switch is off next time */
  }
}

/** At sign-in: the service again when the user turned it on; at sign-out (`on` false) it stops. */
export function restoreKeepConnection(android: Pick<PlatformAndroid, "keepConnection"> | undefined, signedIn: boolean): void {
  if (!android) return;
  if (signedIn && keepConnectionWanted()) void setKeepConnection(android, true).catch(() => undefined);
  if (!signedIn) void android.keepConnection(false, { title: "", text: "" }).catch(() => undefined);
}
