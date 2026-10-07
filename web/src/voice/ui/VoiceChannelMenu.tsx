// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { Channel, MoveAllResult } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { Button, Dialog } from "../../components/ui";
import { channelName } from "../../lib/names";
import { useToasts } from "../../stores/toasts";
import { voiceErrorMessage } from "../errors";

/** A mass move waiting for its confirmation: everyone elsewhere → `to`, or everyone in `from` → `to`. */
export type PendingMoveAll = { from?: Channel; to: Channel; count: number };

/** The toast after a mass move: how many moved, and why the others stayed (user limit, permissions). */
export function moveAllSummary(result: MoveAllResult, t: ReturnType<typeof useT>): { title: string; detail?: string } {
  const title = t("voice.move_all.done", { count: result.moved.length });
  if (!result.skipped.length) return { title };
  const reasons = [...new Set(result.skipped.map((s) => s.reason))].map((r) => t(`voice.move_all.reason.${r}`)).join(" ");
  return { title, detail: t("voice.move_all.skipped", { count: result.skipped.length, reasons }) };
}

/**
 * The confirmation of a mass move from a voice channel's context menu (design note 4.11: "Move
 * everyone here" and "Move everyone from here to …"). It names how many people move; the node moves only as
 * many as the target's user limit allows and reports the rest.
 */
export function MoveAllConfirm({ roomId, pending, onClose }: { roomId: string; pending: PendingMoveAll; onClose: () => void }) {
  const t = useT();
  const { api } = useNode();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const result = await api.voice.moveAll(roomId, pending.to.id, pending.from?.id);
      useToasts.getState().push({ kind: result.skipped.length ? "warning" : "info", ...moveAllSummary(result, t) });
    } catch (e) {
      useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <Dialog title={t("voice.move_all.confirm_title")} open onClose={onClose}>
      <div className="space-y-4" data-testid="move-all-confirm">
        <p className="text-sm text-fg-1">
          {pending.from
            ? t("voice.move_all.confirm_from", { count: pending.count, from: channelName(pending.from), to: channelName(pending.to) })
            : t("voice.move_all.confirm_everyone", { count: pending.count, to: channelName(pending.to) })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void run()} data-testid="move-all-confirm-button">
            {t("voice.move_all.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
