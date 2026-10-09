// SPDX-License-Identifier: Apache-2.0
/**
 * Message retention of a room (tavrn-protocol PROTOCOL.md §7f, `manage_room`): delete messages after N days, with
 * their attachments. The node's period (`GET /node` `message_retention_days`) is the upper bound: a room can only
 * shorten it; 0 = the node's value. Pinned messages and the welcome channel are kept.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { Section } from "./common";

/** The shorter non-zero of the room's and the node's value (0 = kept). */
export function effectiveRetention(room: number | null | undefined, node: number): number {
  const own = room && room > 0 ? room : 0;
  if (own > 0 && node > 0) return Math.min(own, node);
  return own || node;
}

export function MessageRetentionSection({ room }: { room: RoomDetail }) {
  const { api, home, domain } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM);
  const [days, setDays] = useState(String(room.message_retention_days ?? 0));
  const [busy, setBusy] = useState(false);
  const info = useQuery({ queryKey: home ? ["node"] : ["node", domain], queryFn: () => api.node.info(), staleTime: 10 * 60_000 });
  const bound = info.data?.message_retention_days ?? 0;
  const effective = effectiveRetention(room.message_retention_days, bound);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.rooms.update(room.id, { message_retention_days: Math.max(0, Math.floor(Number(days) || 0)) });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save}>
      <Section title={t("message_retention.title")} description={bound > 0 ? t("message_retention.bound", { days: bound }) : t("message_retention.no_bound")}>
        <Field label={t("message_retention.days")} hint={t("message_retention.days_hint")}>
          <Input
            type="number"
            min={0}
            max={bound > 0 ? bound : 36500}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            disabled={!canManage || busy}
            data-testid="message-retention-days"
          />
        </Field>
        <p className="text-xs text-fg-1" data-testid="message-retention-effective">
          {effective > 0 ? t("message_retention.effective", { days: effective }) : t("message_retention.effective_keep")}
        </p>
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" disabled={busy} data-testid="message-retention-save">
              {t("common.save")}
            </Button>
          </div>
        )}
      </Section>
    </form>
  );
}
