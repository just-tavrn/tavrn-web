// SPDX-License-Identifier: Apache-2.0
/**
 * The Tauri shell's events (`src-tauri/src/events.rs`): notification clicks and tray actions on the desktop; the back
 * gesture, app links, the system bars and push endpoints in the Android app. One IPC channel per page (`shell_events`,
 * the shell keeps the newest), subscribed on the first listener and shared by every member of the platform.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AndroidInsets, PushEndpointKeys, TrayAction } from "./types";

export type ShellEvent =
  | { kind: "open"; path: string }
  | { kind: "tray"; action: TrayAction }
  | { kind: "back" }
  | { kind: "link"; url: string }
  | ({ kind: "insets" } & AndroidInsets)
  | ({ kind: "push_endpoint" } & PushEndpointKeys)
  | { kind: "push_unregistered" };

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
