// SPDX-License-Identifier: Apache-2.0
/**
 * The shell's events for the client, on one IPC channel to the main window (`EVENT_CHANNEL`): the Tauri shell's
 * channels in one stream, with their payloads unchanged. `shell_events`: a notification was clicked (open its
 * conversation), a tray menu item was chosen (mute, deafen, leave voice), deep links wait; `hotkeys`: a press or release of a bound
 * system-wide hotkey. The preload hands them to the subscribers of `tavrnShell.events`; nothing listens before the
 * client subscribed, and a reload subscribes anew.
 */
import { EVENT_CHANNEL } from "../shared/bridge.ts";

export type TrayAction = "mute" | "deafen" | "leave";
export type HotkeyAction = "push_to_talk" | "priority" | "toggle_mute" | "toggle_deafen";

/** The Tauri shell's `ShellEvent` (events.rs); `link` says that deep links wait (`shell.takeLinks`, `deeplink.ts`). */
export type ShellEvent = { kind: "open"; path: string } | { kind: "tray"; action: TrayAction } | { kind: "link" };

/** `BridgeEvent` of the client's `electronBridge.ts`. */
export type BridgeEvent = { channel: "shell_events"; event: ShellEvent } | { channel: "hotkeys"; event: { action: HotkeyAction; pressed: boolean } };

/** The part of a window's `webContents` the events need. */
export interface EventTarget {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

export class ShellEvents {
  readonly #target: () => EventTarget | null;

  /** `target`: the main window's web contents, when it exists. */
  constructor(target: () => EventTarget | null) {
    this.#target = target;
  }

  /** Sends `event` to the client of the main window; false when there is no window. */
  send(event: BridgeEvent): boolean {
    const target = this.#target();
    if (!target || target.isDestroyed()) return false;
    target.send(EVENT_CHANNEL, event);
    return true;
  }
}
