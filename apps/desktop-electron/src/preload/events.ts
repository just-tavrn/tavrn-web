// SPDX-License-Identifier: Apache-2.0
/**
 * `tavrnShell.events`: the shell's events for the page (`src/main/events.ts`). Subscribers get the payload only, never
 * Electron's IPC event (it would hand the page the sender).
 */
import { ipcRenderer } from "electron";
import type { BridgeEvent, TavrnShellBridge } from "@tavrn/web/electronBridge";
import { EVENT_CHANNEL } from "../shared/bridge.ts";

const handlers = new Set<(event: BridgeEvent) => void>();

ipcRenderer.on(EVENT_CHANNEL, (_event, payload: BridgeEvent) => {
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (e) {
      console.error("tavrn: an event handler failed", e);
    }
  }
});

export const events: TavrnShellBridge["events"] = Object.freeze({
  subscribe(handler: (event: BridgeEvent) => void): () => void {
    if (typeof handler !== "function") throw new TypeError("events.subscribe needs a function");
    handlers.add(handler);
    return () => void handlers.delete(handler);
  },
});
