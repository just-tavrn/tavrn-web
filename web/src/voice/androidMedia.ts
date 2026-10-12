// SPDX-License-Identifier: Apache-2.0
/**
 * Android app (docs/ANDROID.md "Permissions"): the runtime permissions of a call, asked right before their first use
 * (joining voice, turning the camera on): the microphone or the camera, and with the microphone the nearby-devices
 * permission for headsets (Android 12+; refusing it only keeps the audio off Bluetooth headsets) and, once per start,
 * the notifications (Android 13+: without them the voice notification with Mute and Leave stays hidden; voice runs
 * on). The webview would
 * ask for the microphone and the camera by itself; asking here first lets the client tell "denied" from "blocked"
 * (only the system settings can grant it now) and say so. Outside the Android app it does nothing.
 */
import { platform, type AndroidPermission, type PermissionAnswer } from "../platform";

/** The answers of the last request per permission (for the error message). */
const answers = new Map<AndroidPermission, PermissionAnswer>();
let notificationsAsked = false;

export async function prepareAndroidMedia(kind: "microphone" | "camera"): Promise<PermissionAnswer | null> {
  const android = platform().android;
  if (!android) return null;
  const answer = await android.requestPermission(kind).catch(() => null);
  if (answer) answers.set(kind, answer);
  if (kind === "microphone" && answer === "granted") {
    await android.requestPermission("bluetooth").catch(() => null);
    if (!notificationsAsked) {
      notificationsAsked = true;
      await android.requestPermission("notifications").catch(() => null);
    }
  }
  return answer;
}

/** The Android app refused the microphone or camera for good: the error message points to the system settings. */
export function androidMediaBlocked(): boolean {
  return !!platform().android && (answers.get("microphone") === "blocked" || answers.get("camera") === "blocked");
}
