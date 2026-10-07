// SPDX-License-Identifier: Apache-2.0
import type { NotifyMenuActions, NotifyMenuState } from "../../lib/menus";
import { inheritedMode, muteUntil, setChannelSetting, setRoomSetting, useNotifications } from "../../stores/notifications";

/**
 * The notification entries of a room (`level = "room"`) or of a channel/DM (`"channel"`, `roomId` null for
 * DMs): the own setting, the inherited one and the actions that change them.
 */
export function useNotifyMenu(level: "room" | "channel", roomId: string | null, conversationId: string | null): { state: NotifyMenuState; actions: NotifyMenuActions } {
  const settings = useNotifications((s) => s.settings);
  if (level === "room" && roomId) {
    const own = settings.rooms[roomId];
    return {
      state: { mode: own?.mode ?? null, inherited: inheritedMode(settings, roomId, "room"), mutedUntil: own?.muted_until ?? null, suppressEveryone: !!own?.suppress_everyone },
      actions: {
        setMode: (mode) => setRoomSetting(roomId, { mode }),
        mute: (hours) => setRoomSetting(roomId, { muted_until: muteUntil(hours) }),
        unmute: () => setRoomSetting(roomId, { muted_until: null }),
        setSuppressEveryone: (on) => setRoomSetting(roomId, { suppress_everyone: on }),
      },
    };
  }
  const id = conversationId ?? "";
  const own = settings.channels[id];
  return {
    state: { mode: own?.mode ?? null, inherited: inheritedMode(settings, roomId, "channel"), mutedUntil: own?.muted_until ?? null },
    actions: {
      setMode: (mode) => setChannelSetting(id, { mode }),
      mute: (hours) => setChannelSetting(id, { muted_until: muteUntil(hours) }),
      unmute: () => setChannelSetting(id, { muted_until: null }),
    },
  };
}
