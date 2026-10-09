// SPDX-License-Identifier: Apache-2.0
/**
 * A result of the "Files" group of the search (SEARCH.md §3.6): an entry of an encrypted files channel with name,
 * folder, size, upload date, uploader and its client-made thumbnail. The index holds no thumbnail bytes and no key:
 * the thumbnail is fetched on demand (the entry's record, decrypted on this device, gives the key; the decrypted
 * picture is cached for the session in `files/e2ee.ts`).
 */
import { useEffect, useState } from "react";
import { decryptFileRecord } from "@tavrn/e2ee";
import { formatTime } from "../lib/format";
import { apiFor, isHome } from "../stores/nodes";
import { getMls } from "../stores/mls";
import { thumbnailUrl } from "../files/e2ee";
import { formatBytes } from "../files/model";
import { useT } from "../i18n";
import type { SearchRow } from "./combined";

function useResultThumbnail(row: SearchRow): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!row.file?.thumbnail || !row.roomId) return;
    let stale = false;
    const roomId = row.roomId;
    void (async () => {
      const api = apiFor(isHome(row.node) ? null : row.node);
      const mls = await getMls();
      if (!mls) return;
      const { entry } = await api.files.get(roomId, row.conversationId, row.messageId);
      const r = await decryptFileRecord(mls, `${row.node}/${row.conversationId}`, entry);
      if (!r.ok) return;
      const u = await thumbnailUrl(api, roomId, row.conversationId, entry, r.record);
      if (!stale) setUrl(u);
    })().catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [row]);
  return url;
}

export function FileResult({ row, index, active, uploader, channel, onOpen, onHover }: { row: SearchRow; index: number; active: boolean; uploader: string; channel: string; onOpen: () => void; onHover: () => void }) {
  const t = useT();
  const f = row.file!;
  const thumb = useResultThumbnail(row);
  return (
    <li
      id={`search-row-${index}`}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onOpen}
      onMouseEnter={onHover}
      className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-bg-3/60 aria-selected:bg-bg-3"
      data-testid="search-file-result"
      data-entry={row.messageId}
    >
      {thumb ? (
        <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded object-cover" data-testid="search-file-thumbnail" />
      ) : (
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-bg-2 text-xl">
          {f.kind === "folder" ? "📁" : "📄"}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg-0" data-testid="search-file-name">
          {f.name}
        </p>
        <p className="truncate text-xs text-fg-2">
          {channel}
          {f.folder ? ` / ${f.folder}` : ""}
        </p>
        <p className="truncate text-xs text-fg-2">
          {[f.kind === "folder" ? t("files.folder") : formatBytes(f.size), formatTime(new Date(row.ts).toISOString()), t("search.file_uploader", { name: uploader })].join(" · ")}
        </p>
      </div>
    </li>
  );
}
