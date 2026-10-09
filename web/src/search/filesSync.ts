// SPDX-License-Identifier: Apache-2.0
/**
 * Background sync of encrypted files channels into the local search index (SEARCH.md §3.6): pages through the
 * channel's entry records in the order they were written (`GET …/files/records`, only records inside this member's
 * history window), decrypts what this device can and indexes name, folder path, type, size, upload date and
 * uploader. Folder paths come from the folder records (cached per run; a missing parent is fetched with
 * `GET …/files/{id}`, whose path carries the records of its folders). Renamed entries come again later in the
 * record order and replace their doc.
 */
import type { FileEntry, TavrnApi } from "@tavrn/sdk";
import { decryptFileRecord, type MlsManager } from "@tavrn/e2ee";
import { fileIndexEntries } from "../files/e2ee";

export const FILES_SYNC_PAGE = 100;

interface Folder {
  /** null: the record cannot be read here (the path shows a placeholder for it). */
  name: string | null;
  parent: string | null;
}

/** Folder names and parents of a channel (decrypted folder records), resolving paths. */
export class FolderPaths {
  private readonly folders = new Map<string, Folder | null>();
  constructor(
    private readonly decrypt: (e: FileEntry) => Promise<string | null>,
    private readonly fetch: (id: string) => Promise<{ entry: FileEntry; path: FileEntry[] } | null>,
  ) {}

  async note(e: FileEntry): Promise<void> {
    if (e.kind !== "folder" || this.folders.has(e.id)) return;
    const name = await this.decrypt(e);
    this.folders.set(e.id, { name, parent: e.parent_id ?? null });
  }

  /** "A/B" of a folder id (unreadable folders keep a placeholder segment). */
  async path(id: string | null, placeholder = "…"): Promise<string> {
    const names: string[] = [];
    let cur = id;
    for (let depth = 0; cur && depth < 33; depth++) {
      if (!this.folders.has(cur)) {
        const got = await this.fetch(cur).catch(() => null);
        if (got) {
          for (const f of [...got.path]) await this.note(f);
          await this.note(got.entry);
        }
        if (!this.folders.has(cur)) this.folders.set(cur, null);
      }
      const f = this.folders.get(cur);
      names.unshift(f?.name ?? placeholder);
      cur = f?.parent ?? null;
      if (!f) break;
    }
    return names.join("/");
  }
}

/**
 * One page of records after `after` (an entry id cursor, null = from the start): the index entries and the next
 * cursor (null when the page was the last one).
 */
export async function filesSyncPage(
  api: Pick<TavrnApi, "files">,
  mls: Pick<MlsManager, "decrypt">,
  conversation: string,
  roomId: string,
  channelId: string,
  after: string | null,
) {
  const page = await api.files.records(roomId, channelId, { after, limit: FILES_SYNC_PAGE });
  const decrypt = async (e: FileEntry) => {
    const r = await decryptFileRecord(mls, conversation, e).catch(() => null);
    return r?.ok ? r.record.name : null;
  };
  const paths = new FolderPaths(decrypt, async (id) => {
    const d = await api.files.get(roomId, channelId, id);
    // The path runs from the top level down to the entry itself: each crumb's parent is the crumb before it.
    return { entry: d.entry, path: d.path.map((c, i) => ({ ...d.entry, ...c, kind: "folder", size: 0, parent_id: i > 0 ? d.path[i - 1]!.id : null }) as FileEntry) };
  });
  const results = new Map();
  const folderOf = new Map<string, string>();
  for (const e of page.entries) {
    results.set(e.id, await decryptFileRecord(mls, conversation, e).catch(() => ({ ok: false, reason: "invalid" })));
    await paths.note(e);
  }
  for (const e of page.entries) folderOf.set(e.id, await paths.path(e.parent_id ?? null));
  const docs = page.entries.flatMap((e) => fileIndexEntries(conversation, roomId, [e], results, () => folderOf.get(e.id) ?? "", (x) => x.record_author ?? ""));
  const last = page.entries.at(-1)?.id ?? after;
  return { docs, next: page.next_after ?? null, last };
}
