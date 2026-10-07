// SPDX-License-Identifier: Apache-2.0
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError } from "../../stores/toasts";
import { Section } from "./common";

/** My own privacy switch for this room (design note 4.9): hide my presence from its members. */
export function RoomPresenceSection({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, domain } = useNode();
  const queryClient = useQueryClient();
  const key = ["room-presence", domain, room.id];
  const setting = useQuery({ queryKey: key, queryFn: () => api.presence.roomSetting(room.id), retry: false });
  if (setting.isError) return null;
  return (
    <Section title={t("presence.room_title")} description={t("presence.room_hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-accent"
          checked={!!setting.data?.hidden}
          disabled={!setting.data}
          data-testid="room-hide-presence"
          onChange={async (e) => {
            try {
              queryClient.setQueryData(key, await api.presence.setRoomSetting(room.id, e.target.checked));
            } catch (err) {
              toastError(err);
            }
          }}
        />
        {t("presence.room_hide")}
      </label>
    </Section>
  );
}
