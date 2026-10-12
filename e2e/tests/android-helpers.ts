// SPDX-License-Identifier: Apache-2.0
/**
 * A simulated Android app for Playwright (docs/ANDROID.md): an init script answers the shell's commands like
 * `src-tauri/src/android.rs` does on a phone, so the client runs as the Android app in Chromium. The screen share's
 * native side (`ScreenShare.kt`: Android's consent, the LiveKit Android SDK) is played by the page itself through the
 * development build's `__tavrnFakeScreenPublisher` (`web/src/voice/session.ts`): a second LiveKit connection with the
 * token and the frame key the client hands the shell. The notification's "Stop sharing" is an event the test sends.
 */
import type { Page } from "@playwright/test";

export interface AndroidRecord {
  /** `android_screen_share_start` calls (the key itself is not recorded, only its length). */
  starts: Array<{ url: string; tokenParts: number; keyLength: number; epoch: number; max_side: number; fps: number; max_bitrate: number; audio: boolean; title: string; stop: string }>;
  /** Epochs of `android_screen_share_key`. */
  keys: number[];
  stops: number;
  voice: Array<{ state: string; title: string }>;
}

/** Turns the page's context into the Android app talking to `node`. */
export async function asAndroidShell(page: Page, opts: { node: string; sdk?: number }) {
  await page.context().addInitScript(
    ({ node, sdk }) => {
      type Publisher = { setKey(key: number[], epoch: number): Promise<unknown>; stop(): Promise<void> };
      const w = window as unknown as Record<string, unknown>;
      const record = { starts: [], keys: [], stops: 0, voice: [] } as { starts: unknown[]; keys: number[]; stops: number; voice: unknown[] };
      const callbacks = new Map<number, (m: unknown) => void>();
      let nextId = 1;
      let channel: number | null = null;
      let index = 0;
      let publisher: Publisher | null = null;
      const emit = (event: unknown) => channel !== null && callbacks.get(channel)?.({ index: index++, message: event });
      w.__e2eAndroid = {
        record,
        emit,
        /** The notification's "Stop sharing": the native side stops and tells the client. */
        notificationStop: async () => {
          const p = publisher;
          publisher = null;
          await p?.stop();
          emit({ kind: "screen_share", state: "stopped", reason: "notification" });
        },
      };
      w.isTauri = true;
      w.__TAURI_INTERNALS__ = {
        transformCallback: (cb: (m: unknown) => void) => {
          const id = nextId++;
          callbacks.set(id, cb);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          switch (cmd) {
            case "get_config":
              return { node };
            case "app_info":
              return { version: "0.4.0", updater: false, os: "android" };
            case "android_info":
              return { sdk, webauthn: false, passkeys: false, origin: null, distributors: [], distributor: null, notifications: "granted", battery_exempt: false, keep_connection: false, insets: { top: 0, right: 0, bottom: 0, left: 0, keyboard: 0 } };
            case "shell_events":
              channel = (args.onEvent as { id: number }).id;
              return null;
            case "android_permission":
              return "granted";
            case "android_unlock_status":
              return { available: "unsupported", stored: "none" };
            case "android_audio_routes":
            case "android_audio_route":
              return { available: ["speaker"], current: "speaker" };
            case "get_update_channel":
              return "stable";
            case "android_check_update":
              return null;
            case "android_voice": {
              const n = args.notice as { state: string; title: string };
              record.voice.push({ state: n.state, title: n.title });
              return null;
            }
            case "android_screen_share_start": {
              const s = args.share as { url: string; token: string; key: number[]; epoch: number; max_side: number; fps: number; max_bitrate: number; audio: boolean; title: string; stop: string };
              if (publisher) throw "screen.busy";
              record.starts.push({ url: s.url, tokenParts: s.token.split(".").length, keyLength: s.key.length, epoch: s.epoch, max_side: s.max_side, fps: s.fps, max_bitrate: s.max_bitrate, audio: s.audio, title: s.title, stop: s.stop });
              const fake = w.__tavrnFakeScreenPublisher as ((a: { url: string; token: string; key: number[]; epoch: number }) => Promise<Publisher>) | undefined;
              if (!fake) throw "screen.failed";
              publisher = await fake({ url: s.url, token: s.token, key: s.key, epoch: s.epoch });
              emit({ kind: "screen_share", state: "live" });
              return null;
            }
            case "android_screen_share_key":
              record.keys.push(args.epoch as number);
              if (!publisher) throw "screen.not_running";
              await publisher.setKey(args.key as number[], args.epoch as number);
              return null;
            case "android_screen_share_stop": {
              record.stops++;
              const p = publisher;
              publisher = null;
              await p?.stop();
              return null;
            }
            case "android_screen_share_status":
              return { state: publisher ? "live" : "idle", audio: sdk >= 29 };
            case "notify":
            case "android_push_config":
            case "android_keep_connection":
            case "android_background":
            case "android_orientation":
            case "open_external":
            case "set_update_channel":
              return null;
          }
          throw `unknown command ${cmd}`;
        },
      };
    },
    { node: opts.node, sdk: opts.sdk ?? 36 },
  );
}

export function androidRecord(page: Page): Promise<AndroidRecord> {
  return page.evaluate(() => (window as unknown as { __e2eAndroid: { record: AndroidRecord } }).__e2eAndroid.record);
}

/** The screen share notification's "Stop sharing" button. */
export function stopFromNotification(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as { __e2eAndroid: { notificationStop: () => Promise<void> } }).__e2eAndroid.notificationStop());
}
