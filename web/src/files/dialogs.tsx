// SPDX-License-Identifier: Apache-2.0
/**
 * Dialogs of the file browser: a name prompt (new folder, rename) and the move dialog, a small folder
 * browser that refuses targets inside the moved folders (the node refuses them too, FILES.md §3).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "@tavrn/sdk";
import type { RecordEntry } from "@tavrn/e2ee";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { Button, Dialog, ErrorText, Field, Input } from "../components/ui";
import { describeError } from "../stores/toasts";
import { validName } from "./model";

export function NameDialog({ open, title, initial, action, onClose, onSubmit }: { open: boolean; title: string; initial: string; action: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = validName(name);
  return (
    <Dialog title={title} open={open} onClose={onClose}>
      <form
        className="space-y-3"
        data-testid="files-name-dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          setBusy(true);
          setError(null);
          try {
            await onSubmit(name.trim());
            onClose();
          } catch (err) {
            setError(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("common.name")} hint={name && !valid ? t("files.name_invalid_hint") : undefined}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            autoFocus
            onFocus={(e) => {
              // Select the name without its extension (rename).
              const dot = e.currentTarget.value.lastIndexOf(".");
              e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
            }}
            data-testid="files-name-input"
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!valid || busy} data-testid="files-name-submit">
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Picks a target folder; `moving` are the entries to move (their folders cannot be targets). */
export function MoveDialog({ open, roomId, channelId, moving, onClose, onMove, decryptNames }: {
  open: boolean;
  roomId: string;
  channelId: string;
  moving: FileEntry[];
  onClose: () => void;
  onMove: (target: string | null) => Promise<void>;
  /** Encrypted channels: folder names from the records (FILES.md §8); unreadable folders keep a placeholder. */
  decryptNames?: (entries: RecordEntry[]) => Promise<Map<string, string>>;
}) {
  const t = useT();
  const { api, domain } = useNode();
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ["files-move", domain, channelId, folder],
    queryFn: () => api.files.list(roomId, channelId, { parent: folder, limit: 200 }),
    enabled: open,
  });
  const movingIds = new Set(moving.map((m) => m.id));
  const path = list.data?.path ?? [];
  // Inside one of the moved folders (or the folder itself): not a valid target.
  const blocked = path.some((c) => movingIds.has(c.id));
  // Already there: nothing to do.
  const same = moving.every((m) => (m.parent_id ?? null) === folder);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!decryptNames || !list.data) return;
    let stale = false;
    const crumbs = list.data.path.map((c) => ({ ...c, kind: "folder", size: 0 }));
    void decryptNames([...list.data.entries.filter((e) => e.kind === "folder"), ...crumbs]).then((m) => !stale && setNames(m));
    return () => {
      stale = true;
    };
  }, [decryptNames, list.data]);
  const nameOf = (e: { id: string; name: string }) => (decryptNames ? (names.get(e.id) ?? t("files.locked_folder")) : e.name);
  const folders = (list.data?.entries ?? []).filter((e) => e.kind === "folder");
  return (
    <Dialog title={t("files.move_title", { count: moving.length })} open={open} onClose={onClose}>
      <div className="space-y-3" data-testid="files-move-dialog">
        <nav aria-label={t("files.breadcrumbs")} className="flex flex-wrap items-center gap-1 text-sm">
          <button type="button" className="rounded px-1 text-accent hover:underline" onClick={() => setFolder(null)} data-testid="move-crumb-root">
            {t("files.root")}
          </button>
          {path.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <span className="text-fg-2">/</span>
              <button type="button" className="rounded px-1 text-accent hover:underline" onClick={() => setFolder(c.id)}>
                {nameOf(c)}
              </button>
            </span>
          ))}
        </nav>
        <ul className="max-h-64 min-h-24 overflow-y-auto rounded-md border border-line" role="listbox" aria-label={t("files.folders")}>
          {list.isPending && <li className="p-3 text-sm text-fg-2">{t("common.loading")}</li>}
          {folders.length === 0 && !list.isPending && <li className="p-3 text-sm text-fg-2">{t("files.no_subfolders")}</li>}
          {folders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                disabled={movingIds.has(f.id)}
                onClick={() => setFolder(f.id)}
                className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-40"
                data-testid="move-folder"
                data-name={nameOf(f)}
              >
                <span aria-hidden="true">📁</span>
                <span className="truncate">{nameOf(f)}</span>
              </button>
            </li>
          ))}
        </ul>
        {blocked && <p className="text-xs text-warn">{t("files.move_into_self")}</p>}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={blocked || same || busy}
            data-testid="files-move-here"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onMove(folder);
                onClose();
              } catch (e) {
                setError(describeError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("files.move_here")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
