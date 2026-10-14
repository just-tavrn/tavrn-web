// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { Channel, RoomDetail } from "@tavrn/sdk";
import { parseHistoryPolicy } from "@tavrn/e2ee";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { Section, Select } from "./common";
import { withChannel, type RoomPatch } from "../../lib/roomCache";

type Kind = "since_join" | "days" | "all";

/** The value sent to the node for a choice (`days:<n>` with 1 ≤ n ≤ 3650). */
export function historyPolicyValue(kind: Kind, days: number): string {
  if (kind !== "days") return kind;
  const n = Math.min(3650, Math.max(1, Math.round(Number.isFinite(days) ? days : 1)));
  return `days:${n}`;
}

/**
 * "History for new members" of an encrypted channel (ENCRYPTION.md §7b): how much of the history members who
 * join later can read; other members' devices share the keys with them automatically. Needs
 * `manage_channels`; the change is audit-logged. Narrowing it does not take back keys already shared.
 */
export function HistoryPolicySection({ channel, room, canManage, onChanged }: { channel: Channel; room: RoomDetail; canManage: boolean; onChanged: (patch?: RoomPatch) => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  // Files channels share everything or nothing from before a join (FILES.md §8.7); their default is `all`.
  const files = channel.kind === "files";
  const current = parseHistoryPolicy(channel.history_for_new_members);
  const [kind, setKind] = useState<Kind>(current.kind);
  const [days, setDays] = useState(current.kind === "days" ? current.days : 30);
  const [busy, setBusy] = useState(false);
  const value = historyPolicyValue(kind, days);
  const unchanged = value === (channel.history_for_new_members ?? (files ? "all" : "since_join"));

  const save = async () => {
    setBusy(true);
    try {
      await onChanged(withChannel(await api.channels.update(room.id, channel.id, { history_for_new_members: value })));
      useToasts.getState().push({ kind: "info", title: t("channels.saved") });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("channels.history.title")} description={t(files ? "channels.history.files_hint" : "channels.history.hint")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("channels.history.label")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)} disabled={!canManage || busy} data-testid="history-policy">
            <option value="since_join">{t("channels.history.since_join")}</option>
            {!files && <option value="days">{t("channels.history.days")}</option>}
            <option value="all">{t("channels.history.all")}</option>
          </Select>
        </Field>
        {kind === "days" && (
          <Field label={t("channels.history.days_label")}>
            <Input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={!canManage || busy} data-testid="history-days" />
          </Field>
        )}
      </div>
      <p className="text-xs text-fg-2">{t("channels.history.note")}</p>
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy || unchanged} data-testid="history-policy-save">
            {t("channels.history.save")}
          </Button>
        </div>
      )}
    </Section>
  );
}
