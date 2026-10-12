// SPDX-License-Identifier: Apache-2.0
/**
 * Keeps the screen on while this device is in a voice channel or a call (Screen Wake Lock API), mainly so a phone
 * does not lock in the middle of a conversation. Driven from the voice store, not from a component, so it works
 * wherever the call UI lives. The browser holds the lock only while the page is visible and drops it when the page
 * is hidden: it is requested again when the page becomes visible. Failures (no permission, no support, low battery)
 * only end up in one debug log: the call goes on, the screen just may turn off.
 */
import { platform } from "../platform";
import { useVoiceSettings } from "./settings";
import { useVoice, type VoiceState } from "./store";

type Sentinel = Pick<WakeLockSentinel, "released" | "release" | "addEventListener">;

/** What the controller needs from the browser (tests pass fakes). */
export interface WakeLockEnv {
  wakeLock: { request: (type: "screen") => Promise<Sentinel> } | undefined;
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  /** The desktop app: no-op here for now; the shell will inhibit system sleep in a later version. */
  desktop: boolean;
}

function browserEnv(): WakeLockEnv {
  return {
    wakeLock: typeof navigator === "undefined" ? undefined : navigator.wakeLock,
    document,
    // The Android app keeps the screen on like a phone browser does (its voice service keeps the call alive anyway).
    desktop: platform().isDesktop && !platform().android,
  };
}

/** In a call: connected, or reconnecting within the same call. */
const inCall = (v: VoiceState) => v.status === "connected" || v.status === "reconnecting";

/** Starts the controller; returns the stopper (which releases a held lock). */
export function startWakeLock(env: WakeLockEnv = browserEnv()): () => void {
  const api = env.wakeLock;
  if (env.desktop || !api || typeof api.request !== "function") return () => undefined;
  const doc = env.document;
  let sentinel: Sentinel | null = null;
  let requesting = false;
  let stopped = false;

  const wanted = () => !stopped && inCall(useVoice.getState()) && useVoiceSettings.getState().settings.keepScreenOn && doc.visibilityState === "visible";

  const release = () => {
    const held = sentinel;
    sentinel = null;
    if (held && !held.released) void held.release().catch(() => undefined);
  };

  const sync = () => {
    if (!wanted()) return release();
    if (sentinel || requesting) return;
    requesting = true;
    api.request("screen").then(
      (s) => {
        requesting = false;
        sentinel = s;
        // The browser releases it when the page is hidden; `visibilitychange` asks again.
        s.addEventListener("release", () => {
          if (sentinel === s) sentinel = null;
        });
        // The call ended (or the page was hidden) while the request was pending.
        sync();
      },
      (e: unknown) => {
        requesting = false;
        console.debug("screen wake lock not available", e);
      },
    );
  };

  const offVoice = useVoice.subscribe((now, prev) => {
    if (inCall(now) !== inCall(prev)) sync();
  });
  const offSettings = useVoiceSettings.subscribe((now, prev) => {
    if (now.settings.keepScreenOn !== prev.settings.keepScreenOn) sync();
  });
  doc.addEventListener("visibilitychange", sync);
  sync();

  return () => {
    stopped = true;
    offVoice();
    offSettings();
    doc.removeEventListener("visibilitychange", sync);
    release();
  };
}
