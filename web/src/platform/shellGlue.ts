// SPDX-License-Identifier: Apache-2.0
/**
 * What the shells' platforms share (`tauri.ts`, `tauriAndroid.ts`, `electron.ts`), without any transport: the event
 * rules (tray actions, client paths), the tray status of the shells' answer and the updater around their commands.
 * The transport (Tauri's `invoke`, the Electron bridge) stays in the platform module; nothing here imports one.
 */
import { updateFailure } from "./updateErrors";
import type { AppUpdater, TrayAction, TrayStatus, UpdateChannel } from "./types";

/** Voice actions of the tray menu (Android: the voice notification's buttons). */
export const TRAY_ACTIONS: readonly string[] = ["mute", "deafen", "leave"] satisfies TrayAction[];

export const isTrayAction = (action: unknown): action is TrayAction => typeof action === "string" && TRAY_ACTIONS.includes(action);

/** Views a notification may open besides `/` (the shells' `client_path` and Android's `AppPaths` have the same list). */
const CLIENT_PREFIXES = ["/rooms/", "/n/", "/conversations/", "/dm/", "/settings/"];
const REPORTS = "/admin/reports";

/**
 * Only the client's views (the shell validated them too): never a page that acts on a sign-in (`/connect`, `/sso/…`,
 * `/verify-email`), no dot segments, no other origin.
 */
export const isClientPath = (path: unknown): path is string => {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(path) || /%2e/i.test(path)) return false;
  const bare = path.split(/[?#]/)[0]!;
  if (bare.split("/").some((s) => s === "." || s === "..")) return false;
  return bare === "/" || bare === REPORTS || bare.startsWith(`${REPORTS}/`) || CLIENT_PREFIXES.some((p) => bare.startsWith(p));
};

/** The shells' tray status (snake case) as the client's. */
export function trayStatusOf(s: { state: TrayStatus["state"]; tooltip: string; available: boolean; close_to_tray: boolean }): TrayStatus {
  return { state: s.state, tooltip: s.tooltip, available: s.available, closeToTray: s.close_to_tray };
}

/** A release the shell found. */
export interface FoundUpdate {
  version: string;
  notes?: string | null;
}

/** The shell's update commands; every rejection becomes one of the client's update codes (`updateErrors.ts`). */
export interface UpdateCommands<F extends FoundUpdate> {
  check(): Promise<F | null>;
  install(found: F): Promise<void>;
  getChannel(): Promise<UpdateChannel>;
  setChannel(channel: UpdateChannel): Promise<void>;
}

export function updaterOf<F extends FoundUpdate>(c: UpdateCommands<F>): AppUpdater {
  return {
    check: async () => {
      const found = await c.check().catch(updateFailure);
      if (!found) return null;
      return { version: found.version, notes: found.notes ?? null, install: () => c.install(found).catch(updateFailure) };
    },
    channel: {
      get: () => c.getChannel().catch(updateFailure),
      set: (channel) => c.setChannel(channel).catch(updateFailure),
    },
  };
}
