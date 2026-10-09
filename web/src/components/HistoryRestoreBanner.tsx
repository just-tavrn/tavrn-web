// SPDX-License-Identifier: Apache-2.0
/**
 * The requester's side of the history restore after a key reset (protocol ENCRYPTION.md §7b): in a room whose
 * encrypted history this account lost with its key, a banner explains why older messages are missing and lets the
 * member ask the room's moderators (members with `restore_history`) to restore it, shows the request's state and
 * cancels it. After an approval that did not cover everything it says so.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "./NodeScope";
import { Button } from "./ui";
import { toastError } from "../stores/toasts";
import { restoreKeys, useMyRestoreState } from "../history/restore";
import { formatFullTime } from "../lib/format";

const MAX_MESSAGE = 500;

export function HistoryRestoreBanner({ room }: { room: Pick<RoomDetail, "id" | "history_restore"> }) {
  const t = useT();
  const { api, home, domain } = useNode();
  const node = home ? null : domain;
  const queryClient = useQueryClient();
  const state = useMyRestoreState(api, node, room.id);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const data = state.data;
  if (!data?.key_reset_at) return null;
  const request = data.request ?? null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: restoreKeys.mine(node, room.id) });

  if (data.restored_at) {
    if (!request?.partial) return null;
    return (
      <div role="status" data-testid="history-restore-partial" className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-xs text-fg-1">
        {t("history_restore.partial", { by: request.decided_by ?? "" })}
      </div>
    );
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.historyRequests.create(room.id, message.trim() || undefined);
      setOpen(false);
      setMessage("");
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!request) return;
    setBusy(true);
    try {
      await api.historyRequests.cancel(room.id, request.id);
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const disabled = room.history_restore === "off";
  const pending = request?.status === "open";
  const denied = request?.status === "denied";

  return (
    <div role="region" aria-label={t("history_restore.banner_label")} data-testid="history-restore-banner" data-state={pending ? "open" : denied ? "denied" : disabled ? "off" : "none"} className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-fg-0">
      <p className="font-medium">
        <span aria-hidden="true">🔑 </span>
        {t("history_restore.banner_title")}
      </p>
      <p className="mt-0.5 text-xs text-fg-1">{t("history_restore.banner_text", { at: formatFullTime(data.key_reset_at) })}</p>
      {disabled && !pending && <p className="mt-1 text-xs text-fg-1">{t("history_restore.disabled")}</p>}
      {pending && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-fg-1" data-testid="history-restore-status">
            {t("history_restore.waiting", { at: formatFullTime(request.created_at) })}
          </p>
          <Button variant="ghost" onClick={() => void cancel()} disabled={busy} data-testid="history-restore-cancel">
            {t("history_restore.cancel")}
          </Button>
        </div>
      )}
      {denied && (
        <p className="mt-1 text-xs text-fg-1" data-testid="history-restore-denied">
          {t("history_restore.denied", { by: request.decided_by ?? "", reason: request.reason ?? "" })}
        </p>
      )}
      {!pending && !disabled && !open && (
        <Button className="mt-2" onClick={() => setOpen(true)} data-testid="history-restore-ask">
          {t(denied ? "history_restore.ask_again" : "history_restore.ask")}
        </Button>
      )}
      {!pending && !disabled && open && (
        <form onSubmit={send} className="mt-2 space-y-2">
          <label className="block text-xs text-fg-1">
            {t("history_restore.message_label")}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={MAX_MESSAGE}
              rows={2}
              className="mt-1 w-full rounded-md border border-line-strong bg-bg-0 px-3 py-2 text-sm text-fg-0 outline-none placeholder:text-fg-2 focus:border-accent"
              placeholder={t("history_restore.message_placeholder")}
              data-testid="history-restore-message"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy} data-testid="history-restore-send">
              {t("history_restore.send")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
