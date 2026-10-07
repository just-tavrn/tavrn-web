// SPDX-License-Identifier: Apache-2.0
/**
 * Files channels (design note 4.13 item 9, tavrn-protocol/FILES.md), the pure part of the file browser: sorting,
 * name rules (mirroring the node), selection with Shift/Ctrl, keyboard focus movement, the upload queue
 * and small formatting helpers. Everything here is unit-tested; the view only wires it to React.
 */
import type { FileEntry, FilesInfo } from "@tavrn/sdk";

export type SortKey = "name" | "size" | "modified" | "type";
export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The extension of a name (lowercase, without the dot; empty for none or dotfiles). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Folders first, then by the chosen key; ties by name. */
export function sortEntries(entries: readonly FileEntry[], sort: SortState): FileEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: FileEntry, b: FileEntry) => collator.compare(a.name, b.name);
  const by: Record<SortKey, (a: FileEntry, b: FileEntry) => number> = {
    name: byName,
    size: (a, b) => a.size - b.size,
    modified: (a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0),
    type: (a, b) => collator.compare(extensionOf(a.name), extensionOf(b.name)),
  };
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return sign * by[sort.key](a, b) || byName(a, b);
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/;

/** Mirrors the node's rule (FILES.md §2): 1–255 characters, no `/` or `\`, no control characters, not `.`/`..`. */
export function validName(raw: string): boolean {
  const name = raw.normalize("NFC").trim();
  const length = [...name].length;
  return length >= 1 && length <= 255 && !/[/\\]/.test(name) && !CONTROL.test(name) && name !== "." && name !== "..";
}

// ---------------------------------------------------------------- Selection and focus

export interface Selection {
  ids: ReadonlySet<string>;
  /** Start of a Shift range. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

/**
 * A click (or Space) on `id`: plain = only it, Ctrl/Cmd = toggle it, Shift = the range from the anchor
 * (added to the selection with Ctrl as well).
 */
export function selectWith(sel: Selection, order: readonly string[], id: string, mods: { shift?: boolean; ctrl?: boolean } = {}): Selection {
  if (mods.shift && sel.anchor && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(id);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const ids = new Set(mods.ctrl ? [...sel.ids, ...range] : range);
    return { ids, anchor: sel.anchor };
  }
  if (mods.ctrl) {
    const ids = new Set(sel.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id };
  }
  return { ids: new Set([id]), anchor: id };
}

/** Everything (Ctrl+A). */
export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/** Drops ids that are no longer listed. */
export function pruneSelection(sel: Selection, order: readonly string[]): Selection {
  const present = new Set(order);
  const ids = new Set([...sel.ids].filter((id) => present.has(id)));
  if (ids.size === sel.ids.size && (!sel.anchor || present.has(sel.anchor))) return sel;
  return { ids, anchor: sel.anchor && present.has(sel.anchor) ? sel.anchor : null };
}

export type NavKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageDown" | "PageUp";

/** The next focused id for a navigation key; `columns` > 1 in the grid view (left/right move by one). */
export function moveFocus(order: readonly string[], focus: string | null, key: NavKey, columns = 1, page = 10): string | null {
  if (order.length === 0) return null;
  const i = focus ? order.indexOf(focus) : -1;
  const last = order.length - 1;
  const clamp = (n: number) => Math.max(0, Math.min(last, n));
  if (i < 0) return key === "End" || key === "ArrowUp" ? order[last]! : order[0]!;
  const step: Record<NavKey, number> = {
    ArrowDown: columns,
    ArrowUp: -columns,
    ArrowRight: columns > 1 ? 1 : 0,
    ArrowLeft: columns > 1 ? -1 : 0,
    PageDown: page * columns,
    PageUp: -page * columns,
    Home: -Infinity,
    End: Infinity,
  };
  const s = step[key];
  return order[s === -Infinity ? 0 : s === Infinity ? last : clamp(i + s)]!;
}

// ---------------------------------------------------------------- Uploads

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  /** 0–1. */
  progress: number;
  status: "queued" | "uploading" | "done" | "error" | "cancelled";
  error?: string;
}

export type UploadAction =
  | { type: "add"; items: Array<Pick<UploadItem, "key" | "name" | "size">> }
  | { type: "start"; key: string }
  | { type: "progress"; key: string; progress: number }
  | { type: "done"; key: string }
  | { type: "error"; key: string; error: string }
  | { type: "cancel"; key: string }
  | { type: "clear" };

export function uploadsReducer(items: UploadItem[], a: UploadAction): UploadItem[] {
  const patch = (key: string, p: Partial<UploadItem>) => items.map((i) => (i.key === key ? { ...i, ...p } : i));
  switch (a.type) {
    case "add":
      return [...items, ...a.items.map((i) => ({ ...i, progress: 0, status: "queued" as const }))];
    case "start":
      return patch(a.key, { status: "uploading" });
    case "progress":
      return patch(a.key, { progress: Math.max(0, Math.min(1, a.progress)) });
    case "done":
      return patch(a.key, { status: "done", progress: 1 });
    case "error":
      return patch(a.key, { status: "error", error: a.error });
    case "cancel":
      return patch(a.key, { status: "cancelled" });
    case "clear":
      return items.filter((i) => i.status === "queued" || i.status === "uploading");
  }
}

/** Overall progress of the active and finished uploads, weighted by size (null when nothing runs). */
export function totalProgress(items: readonly UploadItem[]): number | null {
  const relevant = items.filter((i) => i.status !== "cancelled" && i.status !== "error");
  if (!relevant.some((i) => i.status === "queued" || i.status === "uploading")) return null;
  const total = relevant.reduce((n, i) => n + Math.max(1, i.size), 0);
  return relevant.reduce((n, i) => n + Math.max(1, i.size) * (i.status === "done" ? 1 : i.progress), 0) / total;
}

/** Files the client can refuse before uploading: too large, or a category the member may not upload. */
export function precheck(file: { name: string; size: number }, info: Pick<FilesInfo, "max_upload_bytes" | "limit_bytes" | "used_bytes">): "too_large" | "quota" | null {
  if (info.max_upload_bytes > 0 && file.size > info.max_upload_bytes) return "too_large";
  if (info.limit_bytes > 0 && info.used_bytes + file.size > info.limit_bytes) return "quota";
  return null;
}

// ---------------------------------------------------------------- Formatting

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

/** Used share of the limit (0–1), or null without a limit. */
export function usageFraction(used: number, limit: number): number | null {
  if (!(limit > 0)) return null;
  return Math.min(1, Math.max(0, used / limit));
}

/** A glyph for an entry (folders, media kinds, archives, documents). */
export function entryIcon(e: Pick<FileEntry, "kind" | "mime" | "name">): string {
  if (e.kind === "folder") return "📁";
  const ext = extensionOf(e.name);
  if (e.mime === "image/svg+xml" || ext === "svg") return "📄";
  if (e.mime.startsWith("image/")) return "🖼";
  if (e.mime.startsWith("video/")) return "🎞";
  if (e.mime.startsWith("audio/")) return "🎵";
  if (["zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2", "zst"].includes(ext)) return "🗜";
  if (e.mime === "application/pdf" || ["pdf", "doc", "docx", "odt", "txt", "md", "rtf"].includes(ext)) return "📄";
  if (["xls", "xlsx", "ods", "csv"].includes(ext)) return "📊";
  return "📎";
}

/** May the requester rename, move or delete this entry? (Own: upload right; others: `manage_files`.) */
export function canModify(e: Pick<FileEntry, "created_by">, me: string | null | undefined, info: Pick<FilesInfo, "can_manage"> & { can_attach: boolean }): boolean {
  if (info.can_manage) return true;
  return info.can_attach && !!me && e.created_by === me;
}

/** Drag payload type of entries dragged within the browser (moving them onto a folder). */
export const DRAG_TYPE = "application/x-tavrn-file-entries";
