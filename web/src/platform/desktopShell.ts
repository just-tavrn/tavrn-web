// SPDX-License-Identifier: Apache-2.0
/**
 * The client's side of the desktop app's tray and notification clicks (docs/DESKTOP.md "Tray"): the voice store
 * drives `platform().tray` (state and texts, at most every 150 ms, so speaking does not make the tray flicker), the
 * tray's menu mutes, deafens and leaves through the voice client, and a clicked notification opens its conversation.
 * Platform-independent: it takes the members it needs, so the browser never runs it and tests pass fakes.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { Conversation } from "@tavrn/sdk";
import { t, useLocale } from "../i18n";
import { locate } from "../lib/notify";
import { channelName } from "../lib/names";
import { useVoice, type VoiceState } from "../voice/store";
import { leaveVoice, toggleDeafen, toggleMute } from "../voice";
import type { PlatformNotifications, PlatformTray, TrayLabels, TrayVoiceState } from "./types";

/** At most one tray update per this many milliseconds. */
export const TRAY_INTERVAL_MS = 150;

/** The tray's state: deafened wins over muted, muted over speaking. */
export function trayVoiceState(v: Pick<VoiceState, "status" | "muted" | "deafened" | "serverMuted" | "transmitting">): TrayVoiceState {
  if (v.status !== "connected" && v.status !== "reconnecting") return "disconnected";
  if (v.deafened) return "deafened";
  if (v.muted || v.serverMuted) return "muted";
  return v.transmitting ? "speaking" : "connected";
}

/** The voice channel ("Lounge (Gaming)") or the call ("Bob") of the voice connection, from the query cache. */
function channelLabel(queryClient: QueryClient, v: VoiceState, self: string | null): string | null {
  if (!v.target) return null;
  const where = locate(queryClient, v.target.channelId);
  if (where.room) {
    const channel = where.room.channels.find((c) => c.id === v.target?.channelId);
    return channel ? `${channelName(channel)} (${where.room.name})` : where.room.name;
  }
  const c: Conversation | null = where.conversation;
  if (!c) return null;
  if (c.kind === "group" && c.name) return c.name;
  return c.members.filter((m) => m.address !== self).map((m) => m.display_name || m.address.split("@")[0]).join(", ") || null;
}

function labels(state: TrayVoiceState, channel: string | null): TrayLabels {
  return {
    tooltip: state === "disconnected" || !channel ? t("tray.tooltip_idle") : t("tray.tooltip", { channel, state: t(`tray.state.${state}`) }),
    show: t("tray.show"),
    hide: t("tray.hide"),
    mute: t("tray.mute"),
    deafen: t("tray.deafen"),
    leave: t("tray.leave"),
    quit: t("tray.quit"),
  };
}

export interface DesktopShellOptions {
  tray?: PlatformTray;
  notifications?: PlatformNotifications;
  queryClient: QueryClient;
  /** The own address (a call is named by the other members). */
  self: string | null;
  navigate: (path: string) => void;
}

/** Starts the wiring; returns the stopper. */
export function startDesktopShell({ tray, notifications, queryClient, self, navigate }: DesktopShellOptions): () => void {
  const stops: Array<() => void> = [];
  if (tray) {
    let last = "";
    let lastAt = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      timer = null;
      const v = useVoice.getState();
      const state = trayVoiceState(v);
      const next = { state, labels: labels(state, channelLabel(queryClient, v, self)) };
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      lastAt = Date.now();
      void tray.set(next.state, next.labels).catch(() => undefined);
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(send, Math.max(0, lastAt + TRAY_INTERVAL_MS - Date.now()));
    };
    schedule();
    stops.push(useVoice.subscribe(schedule), useLocale.subscribe(schedule), () => {
      if (timer) clearTimeout(timer);
      // Signed out (the layout unmounts): the tray shows the plain logo again.
      void tray.set("disconnected", labels("disconnected", null)).catch(() => undefined);
    });
    stops.push(
      tray.onAction((action) => {
        if (action === "mute") void toggleMute().catch(() => undefined);
        if (action === "deafen") void toggleDeafen().catch(() => undefined);
        if (action === "leave") void leaveVoice().catch(() => undefined);
      }),
    );
  }
  if (notifications) stops.push(notifications.onOpen((path) => navigate(path)));
  return () => stops.forEach((stop) => stop());
}
