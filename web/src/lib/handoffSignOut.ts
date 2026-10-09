// SPDX-License-Identifier: Apache-2.0
/**
 * The node's page in the desktop app's sign-in window (docs/DESKTOP.md "Signing in") signs itself out once its handoff
 * is done, so no orphan "Browser" device of the page stays in the account's device list. A browser tab (the Linux
 * fallback) keeps its session, as a browser user expects; the caller decides ({@link inSignInWindow}).
 *
 * A sign-in code is exchanged only while the device that issued it has a live session (FEDERATION.md §8), so after a
 * sign-in the page waits until the app has exchanged it: the app's device appears in the device list (or, when the app
 * continued its own device with a device proof, that device's last login moves). The page only reads its own device
 * list; polling the app session would hand the code to the page instead of the app. Once the code expired it can no
 * longer be exchanged and the page signs out anyway. An unlock hands no code over: the page signs out at once.
 */
import { TavrnApiError, type DeviceInfo } from "@tavrn/sdk";

/** The page's poll of its device list while it waits for the app's exchange. */
export const HANDOFF_POLL_MS = 1000;
/** Lifetime of a sign-in code on the node (FEDERATION.md §8: 120 seconds). */
export const HANDOFF_CODE_TTL_MS = 120_000;

export interface HandoffSignOut {
  /** The device list right before the confirmation (null: unavailable, the page waits out the code's lifetime). */
  before: DeviceInfo[] | null;
  /** A sign-in (the app still has to exchange the code); false for an unlock. */
  waitForExchange: boolean;
  devices: () => Promise<DeviceInfo[]>;
  signOut: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True when a device other than the page's own appeared or logged in since `before`. */
function exchanged(before: DeviceInfo[], now: DeviceInfo[]): boolean {
  const seen = new Map(before.map((d) => [d.id, d.last_seen_at]));
  return now.some((d) => !d.current && (!seen.has(d.id) || seen.get(d.id) !== d.last_seen_at));
}

export async function signOutAfterHandoff({ before, waitForExchange, devices, signOut, sleep = wait }: HandoffSignOut): Promise<void> {
  if (waitForExchange) {
    if (!before) {
      await sleep(HANDOFF_CODE_TTL_MS);
    } else {
      for (let waited = 0; waited < HANDOFF_CODE_TTL_MS; waited += HANDOFF_POLL_MS) {
        await sleep(HANDOFF_POLL_MS);
        try {
          if (exchanged(before, await devices())) break;
        } catch (e) {
          // The node's answer (the page's session revoked elsewhere, …) ends the wait; a network hiccup does not.
          if (e instanceof TavrnApiError) break;
        }
      }
    }
  }
  await signOut().catch(() => undefined);
}
