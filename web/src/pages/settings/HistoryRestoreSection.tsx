// SPDX-License-Identifier: Apache-2.0
/**
 * Room setting `history_restore` (protocol ENCRYPTION.md §7b "History after a key reset"): whether members whose
 * security key was reset may ask for their encrypted history. Owner or `manage_room`; only on nodes with the capability.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError } from "../../stores/toasts";
import { useRestoreSupported } from "../../history/restore";
import { Section } from "./common";

export function HistoryRestoreSection({ room }: { room: RoomDetail }) {
  const { api, home, domain } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const supported = useRestoreSupported(home ? null : domain);
  const [busy, setBusy] = useState(false);
  if (!supported) return null;
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM);
  const on = room.history_restore !== "off";
  const apply = async (next: boolean) => {
    setBusy(true);
    try {
      await api.rooms.update(room.id, { history_restore: next ? "request" : "off" });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("history_restore.setting_title")} description={t("history_restore.setting_hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={on} disabled={!canManage || busy} onChange={(e) => void apply(e.target.checked)} data-testid="room-history-restore" />
        {t("history_restore.setting_toggle")}
      </label>
    </Section>
  );
}
