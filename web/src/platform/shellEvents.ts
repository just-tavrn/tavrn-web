// SPDX-License-Identifier: Apache-2.0
/**
 * The Tauri shell's events (`src-tauri/src/events.rs`): notification clicks and tray actions on the desktop; the back
 * gesture, app links, the system bars and push endpoints in the Android app. One IPC channel per page (`shell_events`,
 * the shell keeps the newest), subscribed on the first listener and shared by every member of the platform.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AndroidInsets, AndroidScreenStopReason, AudioRoutes, PushEndpointKeys, TrayAction } from "./types";

export type ShellEvent =
  | { kind: "open"; path: string }
  | { kind: "tray"; action: TrayAction }
  | { kind: "back" }
  | { kind: "link"; url: string }
  | ({ kind: "insets" } & AndroidInsets)
  | ({ kind: "push_endpoint" } & PushEndpointKeys)
  | { kind: "push_unregistered" }
  | ({ kind: "audio_routes" } & AudioRoutes)
  | { kind: "screen_share"; state: "live" | "stopped"; reason?: AndroidScreenStopReason }
  | { kind: "game"; name: string | null };

export interface ShellEvents {
  /** Listens to every event; returns the unsubscriber. */
  on(fn: (event: ShellEvent) => void): () => void;
}

export function createShellEvents(): ShellEvents {
  const listeners = new Set<(event: ShellEvent) => void>();
  let subscribed = false;
  const dispatch = (event: ShellEvent) => {
    if (!event || typeof event !== "object") return;
    for (const fn of listeners) fn(event);
  };
  return {
    on: (fn) => {
      listeners.add(fn);
      if (!subscribed) {
        subscribed = true;
        invoke("shell_events", { onEvent: new Channel<ShellEvent>(dispatch) }).catch(() => {
          subscribed = false;
        });
      }
      return () => void listeners.delete(fn);
    },
  };
}

/** Links kept while nobody listens for them (the link that started the app arrives before the client's prompt). */
const MAX_WAITING_LINKS = 8;

/**
 * The deep links of the shell (`link` events) as `Platform.links`. It listens from its creation on and keeps the links
 * that arrive while no subscriber exists: the shell hands its waiting links to the first listener of the channel, which
 * may be another member (the Android insets, say), long before `DeepLinkPrompt` subscribes.
 */
export function linkEvents(events: ShellEvents): { subscribe(fn: (url: string) => void): () => void } {
  const waiting: string[] = [];
  const subscribers = new Set<(url: string) => void>();
  events.on((e) => {
    if (e.kind !== "link" || typeof e.url !== "string") return;
    if (subscribers.size > 0) for (const fn of subscribers) fn(e.url);
    else if (waiting.length < MAX_WAITING_LINKS) waiting.push(e.url);
  });
  return {
    subscribe: (fn) => {
      subscribers.add(fn);
      for (const url of waiting.splice(0)) fn(url);
      return () => void subscribers.delete(fn);
    },
  };
}
