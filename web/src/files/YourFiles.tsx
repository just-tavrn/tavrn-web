// SPDX-License-Identifier: Apache-2.0
/**
 * "Your files" of an encrypted files channel (FILES.md §8.8): the member's own uploads and folders by ownership
 * alone, with counts, sizes and dates but no names (the node has none, and this device may not be able to read the
 * records: locked device, lost key, epochs it does not hold). Single and bulk deletion. Shown in place of the browser
 * while the device is locked, and on demand from the toolbar.
 */
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { FileEntry } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { Button, Dialog } from "../components/ui";
import { ConfirmDialog } from "../pages/settings/common";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { formatBytes } from "./model";

/** Deletes entries one by one (404: gone already, e.g. inside a deleted folder); returns how many went. */
export async function deleteOwn(del: (id: string) => Promise<unknown>, ids: readonly string[]): Promise<number> {
  let done = 0;
  for (const id of ids) {
    try {
      await del(id);
      done++;
    } catch (e) {
      if ((e as { problem?: { status?: number } }).problem?.status === 404 || (e as { status?: number }).status === 404) continue;
      throw e;
    }
  }
  return done;
}

export function YourFilesPanel({ roomId, channelId, onChanged }: { roomId: string; channelId: string; onChanged: () => void }) {
  const t = useT();
  const { api, domain } = useNode();
  const queryClient = useQueryClient();
  const key = ["files-mine", domain, channelId];
  const mine = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.files.mine(roomId, channelId, { after: pageParam, limit: 100 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_after ?? undefined,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const entries: FileEntry[] = mine.data?.pages.flatMap((p) => p.entries) ?? [];
  const totals = mine.data?.pages[0];
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const all = entries.length > 0 && entries.every((e) => selected.has(e.id));

  return (
    <section className="space-y-3 p-2" aria-labelledby="your-files-title" data-testid="your-files">
      <div className="space-y-1">
        <h2 id="your-files-title" className="text-sm font-semibold text-fg-0">
          {t("files.your_files")}
        </h2>
        <p className="text-xs text-fg-2">{t("files.your_files_hint")}</p>
        {totals && (
          <p className="text-sm text-fg-1" data-testid="your-files-summary">
            {t(totals.files + totals.folders === 1 ? "files.your_files_summary_one" : "files.your_files_summary", { count: totals.files + totals.folders, size: formatBytes(totals.bytes) })}
          </p>
        )}
      </div>
      {mine.isPending && <p className="text-sm text-fg-2">{t("common.loading")}</p>}
      {mine.isError && <p className="text-sm text-danger">{describeError(mine.error)}</p>}
      {mine.isSuccess && entries.length === 0 && <p className="text-sm text-fg-2">{t("files.your_files_empty")}</p>}
      {entries.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
              <input type="checkbox" className="h-6 w-6 accent-accent" checked={all} onChange={() => setSelected(all ? new Set() : new Set(entries.map((e) => e.id)))} data-testid="your-files-all" />
              {t("files.select_all")}
            </label>
            <span className="flex-1" />
            <Button variant="danger" className="min-h-10" disabled={selected.size === 0} onClick={() => setConfirm([...selected])} data-testid="your-files-delete">
              {t("files.delete_selected", { count: selected.size })}
            </Button>
          </div>
          <ul className="divide-y divide-line rounded-md border border-line">
            {entries.map((e) => {
              const when = new Date(e.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
              const label = t(e.kind === "folder" ? "files.your_folder_label" : "files.your_file_label", { date: when, size: formatBytes(e.size + (e.thumbnail_size ?? 0)) });
              return (
                <li key={e.id} className="flex min-h-11 items-center gap-2 px-2 text-sm" data-testid="your-files-row" data-entry={e.id}>
                  <input type="checkbox" className="h-6 w-6 accent-accent" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={label} />
                  <span aria-hidden="true">{e.kind === "folder" ? "📁" : "📄"}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-1">{t(e.kind === "folder" ? "files.locked_folder" : "files.locked_file")}</span>
                  <span className="hidden text-xs tabular-nums text-fg-2 sm:inline">{e.kind === "folder" ? "—" : formatBytes(e.size)}</span>
                  <span className="hidden text-xs text-fg-2 md:inline">{when}</span>
                  <Button variant="ghost" className="min-h-10 px-2 text-xs" aria-label={t("files.delete_one", { label })} onClick={() => setConfirm([e.id])}>
                    {t("common.delete")}
                  </Button>
                </li>
              );
            })}
          </ul>
          {mine.hasNextPage && (
            <Button variant="ghost" onClick={() => void mine.fetchNextPage()} disabled={mine.isFetchingNextPage}>
              {t("files.load_more")}
            </Button>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={t("files.delete_n", { count: confirm?.length ?? 0 })}
        text={<span data-testid="your-files-confirm-text">{t("files.your_files_delete_text", { count: confirm?.length ?? 0 })}</span>}
        actionLabel={t("common.delete")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            const n = await deleteOwn((id) => api.files.delete(roomId, channelId, id), confirm ?? []);
            useToasts.getState().push({ kind: "info", title: t(n === 1 ? "files.your_files_deleted_one" : "files.your_files_deleted", { count: n }) });
          } catch (err) {
            toastError(err);
          }
          setConfirm(null);
          setSelected(new Set());
          void queryClient.invalidateQueries({ queryKey: key });
          onChanged();
        }}
      />
    </section>
  );
}

export function YourFilesDialog({ roomId, channelId, onClose, onChanged }: { roomId: string; channelId: string; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  return (
    <Dialog title={t("files.your_files")} open onClose={onClose}>
      <YourFilesPanel roomId={roomId} channelId={channelId} onChanged={onChanged} />
      <div className="flex justify-end pt-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Dialog>
  );
}
