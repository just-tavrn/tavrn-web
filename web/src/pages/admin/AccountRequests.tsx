// SPDX-License-Identifier: Apache-2.0
/**
 * Data rights on a user's request (design note 4.14 item 3) in the admin users tab: export and delete an account (both
 * need the admin's fresh confirmation and are audited), the list of deletions with their progress and the undo within
 * the grace period.
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TavrnApiError, type AdminUser } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { Button, Dialog, ErrorText, Input } from "../../components/ui";
import { Section } from "../settings/common";
import { downloadJson, exportFilename } from "../settings/AccountDataSections";

/** Buttons in a user row: export, delete on request, or undo a deletion. */
export function UserDataActions({ user }: { user: AdminUser }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [withMessages, setWithMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setDeleting(false), []);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "users"] }), queryClient.invalidateQueries({ queryKey: ["admin", "deletions"] })]);
  if (user.deleted) {
    return (
      <Button
        variant="ghost"
        data-testid="admin-undelete"
        onClick={async () => {
          try {
            await api.legal.undeleteUser(user.id);
            await refresh();
            useToasts.getState().push({ kind: "info", title: t("admin.data.undeleted") });
          } catch (e) {
            toastError(e);
          }
        }}
      >
        {t("admin.data.undelete")}
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="ghost"
        data-testid="admin-export-user"
        onClick={async () => {
          try {
            downloadJson(await api.legal.exportUser(user.id), exportFilename(user.username));
          } catch (e) {
            if (!(e instanceof TavrnApiError && e.code === "auth.reauth_required")) toastError(e);
          }
        }}
      >
        {t("admin.data.export")}
      </Button>
      <Button variant="danger" onClick={() => setDeleting(true)} data-testid="admin-delete-user">
        {t("admin.data.delete")}
      </Button>
      <Dialog title={t("admin.data.delete_title", { name: user.address })} open={deleting} onClose={close}>
        <div className="space-y-3 text-sm text-fg-1">
          <p>{t("admin.data.delete_text")}</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-5 w-5" checked={withMessages} onChange={(e) => setWithMessages(e.target.checked)} />
            <span>{t("legal.delete.messages")}</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-fg-2">{t("legal.delete.type", { word: user.username })}</span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("common.confirmation")} />
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={typed.trim().toLowerCase() !== user.username}
              onClick={async () => {
                setError(null);
                try {
                  await api.legal.deleteUser(user.id, { confirm: typed.trim(), delete_messages: withMessages });
                  setDeleting(false);
                  setTyped("");
                  await refresh();
                } catch (e) {
                  if (!(e instanceof TavrnApiError && e.code === "auth.reauth_required")) setError(describeError(e));
                }
              }}
            >
              {t("legal.delete.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Deleted accounts with progress and the undo. */
export function DeletionsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const deletions = useQuery({ queryKey: ["admin", "deletions"], queryFn: () => api.legal.deletions(), refetchInterval: (q) => (q.state.data?.some((d) => d.state === "processing") ? 2000 : false) });
  if (!deletions.data?.length) return null;
  const now = new Date().toISOString();
  return (
    <Section title={t("admin.data.deletions")} description={t("admin.data.deletions_hint")}>
      <ul className="divide-y divide-line text-sm" data-testid="admin-deletions">
        {deletions.data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-medium">{d.address}</span>
            <span className="rounded bg-bg-3 px-1.5 text-xs">{t(`admin.data.state.${d.state}`)}</span>
            {d.delete_messages && <span className="text-xs text-fg-2">{t("admin.data.messages_progress", { done: d.messages_done, total: d.messages_total })}</span>}
            <span className="flex-1 text-xs text-fg-2">{t("admin.data.until", { date: new Date(d.purge_after).toLocaleDateString(intlLocale()) })}</span>
            {(d.state === "done" || d.state === "processing") && d.purge_after > now && (
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.legal.undeleteUser(d.user_id);
                    await Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "deletions"] }), queryClient.invalidateQueries({ queryKey: ["admin", "users"] })]);
                  } catch (e) {
                    toastError(e);
                  }
                }}
                data-testid="deletion-undo"
              >
                {t("admin.data.undelete")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
