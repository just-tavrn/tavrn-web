// SPDX-License-Identifier: Apache-2.0
/**
 * Attachment retention of a room (design note 4.13 item 2, `manage_room`): delete attachments after N days. The
 * node's period (and room grants) is the upper bound: a room can only shorten it; 0 = the node's value.
 * Pinned messages keep their files.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { Section } from "./common";

export function RetentionSection({ room }: { room: RoomDetail }) {
  const { api, domain } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM);
  const [days, setDays] = useState(String(room.attachment_retention_days ?? 0));
  const [busy, setBusy] = useState(false);
  const limits = useQuery({ queryKey: ["entitlements", domain, room.id], queryFn: () => api.users.entitlements(room.id), staleTime: 60_000 });
  const bound = limits.data?.retention_bound_days ?? 0;
  const effective = limits.data?.values["attachments.retention_days"] ?? 0;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.rooms.update(room.id, { attachment_retention_days: Math.max(0, Math.floor(Number(days) || 0)) });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
      await queryClient.invalidateQueries({ queryKey: ["entitlements", domain, room.id] });
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save}>
      <Section title={t("retention.title")} description={bound > 0 ? t("retention.bound", { days: bound }) : t("retention.no_bound")}>
        <Field label={t("retention.days")} hint={t("retention.days_hint")}>
          <Input type="number" min={0} max={bound > 0 ? bound : 36500} value={days} onChange={(e) => setDays(e.target.value)} disabled={!canManage || busy} data-testid="retention-days" />
        </Field>
        <p className="text-xs text-fg-1" data-testid="retention-effective">
          {effective > 0 ? t("retention.effective", { days: effective }) : t("retention.effective_keep")}
        </p>
        {canManage && (
          <div className="flex justify-end">
            <Button type="submit" disabled={busy} data-testid="retention-save">
              {t("common.save")}
            </Button>
          </div>
        )}
      </Section>
    </form>
  );
}
