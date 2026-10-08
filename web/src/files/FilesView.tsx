// SPDX-License-Identifier: Apache-2.0
/**
 * The file browser of a files channel (design note 4.13 item 9, tavrn-protocol/FILES.md): breadcrumbs, list and grid
 * views, sorting, search, uploads by button or drag and drop with progress, new folder, rename, move (dialog
 * or dragging onto a folder), delete, download, media in the viewer, the context menu, selection with
 * Shift/Ctrl, keyboard navigation, the storage meter and the permanent "not end-to-end encrypted" banner.
 * Phones get the list only and the row menu as their action sheet.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import type { Channel, FileEntry, FilesInfo, RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { ContextMenu, menuItem, normalizeMenu, separator, type MenuEntry } from "../components/ContextMenu";
import { pointAnchor, rectOf, type AnchorRect } from "../lib/position";
import { AudioPlayer, mediaKind, saveUrl, useAttachmentUrl, type ViewAttachment } from "../components/AttachmentView";
import { Button, Dialog } from "../components/ui";
import { ConfirmDialog } from "../pages/settings/common";
import { useRoomMembers } from "../pages/ChannelPage";
import { channelName } from "../lib/names";
import { memberName } from "../lib/memberGroups";
import { isSvg, shouldAutoPreview } from "../lib/preview";
import { usePrivacy } from "../stores/privacy";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { MoveDialog, NameDialog } from "./dialogs";
import {
  DEFAULT_SORT,
  DRAG_TYPE,
  EMPTY_SELECTION,
  canModify,
  entryIcon,
  formatBytes,
  moveFocus,
  precheck,
  pruneSelection,
  selectAll,
  selectWith,
  sortEntries,
  totalProgress,
  uploadsReducer,
  usageFraction,
  type NavKey,
  type SortKey,
  type SortState,
} from "./model";

const MediaViewer = lazy(() => import("../components/MediaViewer"));

const VIEW_KEY = "tavrn.files.view";

function readView(): "list" | "grid" {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function usePhone(): boolean {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** Refreshes the open folder when the node announces a change (`files.update`, `files.backend`). */
function useFilesRealtime(domain: string, home: boolean, channelId: string, onChange: () => void) {
  const homeSocket = useRealtimeState((s) => s.socket);
  const nodeSocket = useNodeSockets((s) => s.sockets[domain]);
  const socket = home ? homeSocket : nodeSocket;
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!socket) return;
    const handler = (d: { channel_id?: string }) => d.channel_id === channelId && ref.current();
    const offs = [socket.on<{ channel_id?: string }>("files.update", handler), socket.on<{ channel_id?: string }>("files.backend", handler)];
    return () => offs.forEach((off) => off());
  }, [socket, channelId]);
}

export default function FilesView({ room, channel }: { room: RoomDetail; channel: Channel }) {
  const t = useT();
  const { api, domain, home, me } = useNode();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [viewPref, setViewPref] = useState(readView);
  const view = phone ? "list" : viewPref;
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [focus, setFocus] = useState<string | null>(null);
  const [uploads, dispatchUploads] = useReducer(uploadsReducer, []);
  const aborts = useRef(new Map<string, AbortController>());
  const [dialog, setDialog] = useState<null | { kind: "new-folder" } | { kind: "rename"; entry: FileEntry } | { kind: "move"; entries: FileEntry[] } | { kind: "delete"; entries: FileEntry[] } | { kind: "audio"; entry: FileEntry }>(null);
  const [viewer, setViewer] = useState<{ items: ViewAttachment[]; start: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menuState, setMenuState] = useState<{ anchor: AnchorRect; entries: FileEntry[] } | null>(null);

  // Debounced search.
  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const filesKey = ["files", domain, channel.id] as const;
  const listing = useInfiniteQuery({
    queryKey: [...filesKey, search ? null : folder, search],
    queryFn: ({ pageParam }) => api.files.list(room.id, channel.id, { parent: search ? null : folder, q: search || undefined, after: pageParam, limit: 100 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_after ?? undefined,
  });
  const info = useQuery({ queryKey: ["files-usage", domain, channel.id], queryFn: () => api.files.usage(room.id, channel.id) });
  const members = useRoomMembers(room.id);
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.user.id, memberName(m)])), [members.data]);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: filesKey });
    void queryClient.invalidateQueries({ queryKey: ["files-usage", domain, channel.id] });
    void queryClient.invalidateQueries({ queryKey: ["files-move", domain, channel.id] });
    // `filesKey` is derived from domain and channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, domain, channel.id]);
  useFilesRealtime(domain, home, channel.id, refresh);

  const entries = useMemo(() => sortEntries(listing.data?.pages.flatMap((p) => p.entries) ?? [], sort), [listing.data, sort]);
  const order = useMemo(() => entries.map((e) => e.id), [entries]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const path = search ? [] : (listing.data?.pages[0]?.path ?? []);
  useEffect(() => setSelection((s) => pruneSelection(s, order)), [order]);
  useEffect(() => {
    setSelection(EMPTY_SELECTION);
    setFocus(null);
  }, [folder, search]);

  const i: FilesInfo | undefined = info.data;
  const rights = { can_manage: !!i?.can_manage, can_attach: !!i?.can_upload };
  const canUpload = !!i?.can_upload;
  const selected = entries.filter((e) => selection.ids.has(e.id));
  const modifiable = (list: FileEntry[]) => list.length > 0 && list.every((e) => canModify(e, me?.id, rights));

  const openFolder = (id: string | null) => {
    setQuery("");
    setSearch("");
    const next = new URLSearchParams(params);
    if (id) next.set("folder", id);
    else next.delete("folder");
    setParams(next);
  };

  const asView = (e: FileEntry): ViewAttachment => ({ id: e.id, name: e.name, mime: e.mime, size: e.size, encrypted: null, load: () => api.files.download(room.id, channel.id, e.id) });

  const download = async (e: FileEntry) => {
    try {
      const blob = await api.files.download(room.id, channel.id, e.id);
      const url = URL.createObjectURL(blob.slice(0, blob.size, "application/octet-stream"));
      saveUrl(url, e.name);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toastError(err);
    }
  };

  const open = (e: FileEntry) => {
    if (e.kind === "folder") return openFolder(e.id);
    const kind = mediaKind(e.mime, e.name);
    if (kind === "image" || kind === "video") {
      const visual = entries.filter((x) => x.kind === "file" && ["image", "video"].includes(mediaKind(x.mime, x.name)));
      setViewer({ items: visual.map(asView), start: visual.findIndex((x) => x.id === e.id) });
    } else if (kind === "audio") setDialog({ kind: "audio", entry: e });
    else void download(e);
  };

  // ---------------------------------------------------------------- Uploads

  const uploadFiles = async (files: File[], target: string | null = search ? null : folder) => {
    if (!i) return;
    const items = files.map((f, n) => ({ key: `${Date.now()}-${n}-${f.name}`, name: f.name, size: f.size, file: f }));
    dispatchUploads({ type: "add", items: items.map(({ key, name, size }) => ({ key, name, size })) });
    for (const item of items) {
      const refused = precheck(item.file, i);
      if (refused) {
        dispatchUploads({ type: "error", key: item.key, error: t(refused === "too_large" ? "files.too_large" : "files.quota_full", { max: formatBytes(i.max_upload_bytes) }) });
        continue;
      }
      const abort = new AbortController();
      aborts.current.set(item.key, abort);
      dispatchUploads({ type: "start", key: item.key });
      try {
        await api.files.upload(room.id, channel.id, item.file, item.name, { parentId: target, rename: true, signal: abort.signal, onProgress: (p) => dispatchUploads({ type: "progress", key: item.key, progress: p }) });
        dispatchUploads({ type: "done", key: item.key });
      } catch (err) {
        if (abort.signal.aborted) dispatchUploads({ type: "cancel", key: item.key });
        else dispatchUploads({ type: "error", key: item.key, error: describeError(err) });
      } finally {
        aborts.current.delete(item.key);
      }
      refresh();
    }
  };

  // ---------------------------------------------------------------- Actions

  const moveEntries = async (list: FileEntry[], target: string | null) => {
    for (const e of list) await api.files.update(room.id, channel.id, e.id, { parent_id: target });
    refresh();
  };

  const menuFor = (list: FileEntry[]): MenuEntry[] => {
    const one = list.length === 1 ? list[0]! : null;
    const may = modifiable(list);
    const reason = t("files.no_right");
    return normalizeMenu([
      one && menuItem("open", one.kind === "folder" ? t("files.open_folder") : t("files.open"), () => open(one)),
      one?.kind === "file" && menuItem("download", t("files.download"), () => void download(one)),
      separator("s1"),
      one && menuItem("rename", t("files.rename"), () => setDialog({ kind: "rename", entry: one }), { disabled: !may, reason }),
      menuItem("move", t("files.move"), () => setDialog({ kind: "move", entries: list }), { disabled: !may, reason }),
      !!search && one && menuItem("location", t("files.show_location"), () => openFolder(one.parent_id ?? null)),
      separator("s2"),
      menuItem("delete", list.length > 1 ? t("files.delete_n", { count: list.length }) : t("files.delete"), () => setDialog({ kind: "delete", entries: list }), { danger: true, disabled: !may, reason }),
    ]);
  };

  /** The menu of an entry (or of the selection it belongs to), at a pointer position or an element. */
  const openMenu = (e: FileEntry, at: Element | null, point?: { x: number; y: number }) => {
    const list = selection.ids.has(e.id) ? selected : [e];
    if (!selection.ids.has(e.id)) setSelection(selectWith(EMPTY_SELECTION, order, e.id));
    setFocus(e.id);
    const anchor = point ? pointAnchor(point.x, point.y) : at ? rectOf(at) : null;
    if (anchor) setMenuState({ anchor, entries: list });
  };

  /** Dropping dragged entries on the top-level crumb moves them to the top level. */
  const rootDrop = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onDrop: (e: DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      const list = (JSON.parse(raw) as string[]).map((id) => byId.get(id)).filter((x): x is FileEntry => !!x);
      if (list.length && modifiable(list)) void moveEntries(list, null).catch(toastError);
    },
  };

  // ---------------------------------------------------------------- Keyboard

  const columns = () => {
    if (view !== "grid" || !listRef.current) return 1;
    const cols = getComputedStyle(listRef.current.querySelector("[data-grid]") ?? listRef.current).gridTemplateColumns.split(" ").filter(Boolean).length;
    return Math.max(1, cols);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const nav: NavKey[] = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "PageUp"];
    if ((nav as string[]).includes(e.key)) {
      e.preventDefault();
      const next = moveFocus(order, focus, e.key as NavKey, columns());
      if (!next) return;
      setFocus(next);
      setSelection((s) => (e.shiftKey ? selectWith(s, order, next, { shift: true }) : e.ctrlKey || e.metaKey ? s : selectWith(s, order, next)));
      listRef.current?.querySelector<HTMLElement>(`[data-entry="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    const current = focus ? byId.get(focus) : undefined;
    if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && current) {
      e.preventDefault();
      openMenu(current, listRef.current?.querySelector(`[data-entry="${current.id}"]`) ?? null);
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      open(current);
    } else if (e.key === " " && current) {
      e.preventDefault();
      setSelection((s) => selectWith(s, order, current.id, { ctrl: true }));
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection(selectAll(order));
    } else if (e.key === "Delete" && selected.length && modifiable(selected)) {
      e.preventDefault();
      setDialog({ kind: "delete", entries: selected });
    } else if (e.key === "F2" && selected.length === 1 && modifiable(selected)) {
      e.preventDefault();
      setDialog({ kind: "rename", entry: selected[0]! });
    } else if (e.key === "Backspace" && !search && path.length) {
      e.preventDefault();
      openFolder(path.length > 1 ? path[path.length - 2]!.id : null);
    } else if (e.key === "Escape") {
      setSelection(EMPTY_SELECTION);
    }
  };

  // ---------------------------------------------------------------- Drag and drop

  const onDragOver = (e: DragEvent) => {
    if (!canUpload || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDropActive(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropActive(false);
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length && canUpload) void uploadFiles(files);
  };
  const dropOnFolder = (target: FileEntry) => ({
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE) || (canUpload && e.dataTransfer.types.includes("Files"))) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TYPE) ? "move" : "copy";
      }
    },
    onDrop: (e: DragEvent) => {
      e.stopPropagation();
      setDropActive(false);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (raw) {
        e.preventDefault();
        const ids: string[] = JSON.parse(raw);
        const list = ids.map((id) => byId.get(id)).filter((x): x is FileEntry => !!x && x.id !== target.id);
        if (list.length && modifiable(list)) void moveEntries(list, target.id).catch(toastError);
      } else if (e.dataTransfer.files.length && canUpload) {
        e.preventDefault();
        void uploadFiles([...e.dataTransfer.files], target.id);
      }
    },
  });

  // ---------------------------------------------------------------- Render

  const fraction = i ? usageFraction(i.used_bytes, i.limit_bytes) : null;
  const progress = totalProgress(uploads);
  const sortLabel: Record<SortKey, string> = { name: t("files.sort.name"), size: t("files.sort.size"), modified: t("files.sort.modified"), type: t("files.sort.type") };
  const external = i && i.backend !== "internal";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-view" onDragOver={onDragOver} onDragLeave={() => setDropActive(false)} onDrop={onDrop}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="text-fg-2" aria-hidden="true">
          📁
        </span>
        <h1 className="min-w-0 truncate text-sm font-semibold" data-testid="channel-name">
          {channelName(channel)}
        </h1>
        {channel.topic && <span className="hidden truncate text-sm text-fg-2 md:inline">· {channel.topic}</span>}
        <span className="flex-1" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("files.search")}
          aria-label={t("files.search")}
          className="h-8 w-28 min-w-0 rounded-md border border-line-strong bg-bg-0 px-2 text-sm outline-none focus:border-accent sm:w-48"
          data-testid="files-search"
        />
      </header>
      {/* Permanent: files channels are never end-to-end encrypted (PROTOCOL.md §8, FILES.md §1). */}
      <div role="status" data-testid="files-banner" data-backend={i?.backend ?? "internal"} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
        <span aria-hidden="true">🔓</span>
        <span>{t("files.banner")}</span>
        {external && <span data-testid="files-banner-external">{t(i.encrypt_files ? "files.banner_external_encrypted" : "files.banner_external", { kind: t(`files.backend.${i.backend}`) })}</span>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <nav aria-label={t("files.breadcrumbs")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm" data-testid="files-breadcrumbs">
          {search ? (
            <span className="text-fg-1" data-testid="files-search-results">
              {t("files.results_for", { query: search })}
            </span>
          ) : (
            <>
              <button type="button" onClick={() => openFolder(null)} className="rounded px-1 font-medium text-fg-1 hover:bg-bg-3 hover:text-fg-0" data-testid="files-crumb" data-folder="" {...rootDrop}>
                {channelName(channel)}
              </button>
              {path.map((c) => (
                <span key={c.id} className="flex min-w-0 items-center gap-1">
                  <span className="text-fg-2">/</span>
                  <button type="button" onClick={() => openFolder(c.id)} className="max-w-[12rem] truncate rounded px-1 text-fg-1 hover:bg-bg-3 hover:text-fg-0" data-testid="files-crumb" data-folder={c.id}>
                    {c.name}
                  </button>
                </span>
              ))}
            </>
          )}
        </nav>
        <div className="flex items-center gap-1">
          <select
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(":") as [SortKey, "asc" | "desc"];
              setSort({ key, dir });
            }}
            aria-label={t("files.sort")}
            className="h-8 rounded-md border border-line-strong bg-bg-0 px-1 text-xs"
            data-testid="files-sort"
          >
            {(["name", "size", "modified", "type"] as SortKey[]).flatMap((k) =>
              (["asc", "desc"] as const).map((d) => (
                <option key={`${k}:${d}`} value={`${k}:${d}`}>
                  {sortLabel[k]} {d === "asc" ? "↑" : "↓"}
                </option>
              )),
            )}
          </select>
          {!phone && (
            <button
              type="button"
              onClick={() => {
                const next = viewPref === "list" ? "grid" : "list";
                setViewPref(next);
                try {
                  localStorage.setItem(VIEW_KEY, next);
                } catch {
                  /* per-device convenience only */
                }
              }}
              aria-label={viewPref === "list" ? t("files.view_grid") : t("files.view_list")}
              title={viewPref === "list" ? t("files.view_grid") : t("files.view_list")}
              className="h-8 min-w-8 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0"
              data-testid="files-view-toggle"
              data-view={viewPref}
            >
              {viewPref === "list" ? "▦" : "☰"}
            </button>
          )}
          {canUpload && (
            <>
              <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setDialog({ kind: "new-folder" })} data-testid="files-new-folder">
                {t("files.new_folder")}
              </Button>
              <Button className="min-h-8 px-2 text-xs" onClick={() => fileInput.current?.click()} data-testid="files-upload-button">
                {t("files.upload")}
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label={t("files.upload")}
                data-testid="files-upload-input"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (files.length) void uploadFiles(files);
                }}
              />
            </>
          )}
        </div>
      </div>
      {uploads.length > 0 && (
        <div className="shrink-0 border-b border-line bg-bg-1 px-3 py-2" data-testid="files-uploads">
          <div className="mb-1 flex items-center gap-2 text-xs text-fg-2">
            <span className="flex-1">{progress === null ? t("files.uploads_done") : t("files.uploading", { percent: Math.round(progress * 100) })}</span>
            {progress === null && (
              <button type="button" className="rounded px-1 hover:bg-bg-3 hover:text-fg-0" onClick={() => dispatchUploads({ type: "clear" })} data-testid="files-uploads-clear">
                {t("common.close")}
              </button>
            )}
          </div>
          <ul className="max-h-32 space-y-1 overflow-y-auto">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-center gap-2 text-xs" data-testid="upload-item" data-status={u.status}>
                <span className="min-w-0 flex-1 truncate" title={u.name}>
                  {u.name}
                </span>
                {u.status === "error" ? (
                  <span className="max-w-[50%] truncate text-danger" title={u.error}>
                    {u.error}
                  </span>
                ) : (
                  <progress max={1} value={u.progress} className="h-1.5 w-24 sm:w-40" aria-label={t("files.progress", { name: u.name })} />
                )}
                {u.status === "uploading" && (
                  <button type="button" className="rounded px-1 text-fg-2 hover:text-danger" aria-label={t("files.cancel_upload", { name: u.name })} onClick={() => aborts.current.get(u.key)?.abort()}>
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("files.entries")}
        aria-activedescendant={focus ? `file-${focus}` : undefined}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelection(EMPTY_SELECTION);
        }}
        className={`relative min-h-0 flex-1 overflow-y-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${dropActive ? "bg-accent-soft" : ""}`}
        data-testid="files-list"
        data-view={view}
      >
        {listing.isPending && <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>}
        {listing.isError && <p className="p-4 text-sm text-danger">{describeError(listing.error)}</p>}
        {listing.isSuccess && entries.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-fg-2" data-testid="files-empty">
            <span aria-hidden="true" className="text-4xl">
              {search ? "🔍" : "📂"}
            </span>
            <p>{search ? t("files.no_results") : canUpload ? t("files.empty_upload") : t("files.empty")}</p>
          </div>
        )}
        {entries.length > 0 && view === "list" && (
          <div className="min-w-0">
            <div className="hidden grid-cols-[minmax(0,1fr)_7rem_9rem_9rem_2.5rem] gap-2 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2 md:grid" aria-hidden="true">
              <span>{t("common.name")}</span>
              <span className="text-right">{t("files.sort.size")}</span>
              <span>{t("files.sort.modified")}</span>
              <span>{t("files.uploader")}</span>
              <span />
            </div>
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                grid={false}
                selected={selection.ids.has(e.id)}
                focused={focus === e.id}
                owner={e.created_by ? (names.get(e.created_by) ?? null) : null}
                draggable={canModify(e, me?.id, rights)}
                drag={selection.ids.has(e.id) ? selected.map((x) => x.id) : [e.id]}
                folderDrop={e.kind === "folder" ? dropOnFolder(e) : undefined}
                onSelect={(mods) => {
                  setFocus(e.id);
                  setSelection((s) => selectWith(s, order, e.id, mods));
                }}
                onOpen={() => open(e)}
                onMenu={(el, point) => openMenu(e, el, point)}
                load={asView(e)}
                menuLabel={t("files.menu", { name: e.name })}
              />
            ))}
          </div>
        )}
        {entries.length > 0 && view === "grid" && (
          <div data-grid className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                grid
                selected={selection.ids.has(e.id)}
                focused={focus === e.id}
                owner={e.created_by ? (names.get(e.created_by) ?? null) : null}
                draggable={canModify(e, me?.id, rights)}
                drag={selection.ids.has(e.id) ? selected.map((x) => x.id) : [e.id]}
                folderDrop={e.kind === "folder" ? dropOnFolder(e) : undefined}
                onSelect={(mods) => {
                  setFocus(e.id);
                  setSelection((s) => selectWith(s, order, e.id, mods));
                }}
                onOpen={() => open(e)}
                onMenu={(el, point) => openMenu(e, el, point)}
                load={asView(e)}
                menuLabel={t("files.menu", { name: e.name })}
              />
            ))}
          </div>
        )}
        {listing.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button variant="ghost" onClick={() => void listing.fetchNextPage()} disabled={listing.isFetchingNextPage} data-testid="files-load-more">
              {t("files.load_more")}
            </Button>
          </div>
        )}
        {dropActive && (
          <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-lg border-2 border-dashed border-accent text-sm text-accent" data-testid="files-drop-zone">
            {t("files.drop_here")}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-xs text-fg-2" data-testid="files-meter">
        {i && (
          <>
            <span data-testid="files-usage-text">
              {fraction === null ? t("files.usage_unlimited", { used: formatBytes(i.used_bytes) }) : t("files.usage", { used: formatBytes(i.used_bytes), limit: formatBytes(i.limit_bytes) })}
            </span>
            {fraction !== null && (
              <meter min={0} max={1} low={0.75} high={0.9} optimum={0} value={fraction} className="h-2 w-32" aria-label={t("files.usage_meter")} data-testid="files-usage-meter" />
            )}
            <span>{t("files.counts", { files: i.files, folders: i.folders })}</span>
            {selected.length > 0 && <span className="ml-auto">{t("files.selected", { count: selected.length })}</span>}
          </>
        )}
      </footer>
      {menuState && (
        <ContextMenu
          entries={menuFor(menuState.entries)}
          anchor={menuState.anchor}
          onClose={() => setMenuState(null)}
          label={t("files.menu", { name: menuState.entries.length === 1 ? menuState.entries[0]!.name : String(menuState.entries.length) })}
          testId="files-menu"
        />
      )}
      {dialog?.kind === "new-folder" && (
        <NameDialog
          open
          title={t("files.new_folder")}
          initial=""
          action={t("common.create")}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.files.createFolder(room.id, channel.id, name, search ? null : folder);
            refresh();
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          open
          title={t("files.rename")}
          initial={dialog.entry.name}
          action={t("common.save")}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.files.update(room.id, channel.id, dialog.entry.id, { name });
            refresh();
          }}
        />
      )}
      {dialog?.kind === "move" && <MoveDialog open roomId={room.id} channelId={channel.id} moving={dialog.entries} onClose={() => setDialog(null)} onMove={(target) => moveEntries(dialog.entries, target)} />}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          open
          title={dialog.entries.length > 1 ? t("files.delete_n", { count: dialog.entries.length }) : t("files.delete")}
          text={
            <span data-testid="files-delete-text">
              {dialog.entries.length === 1
                ? t(dialog.entries[0]!.kind === "folder" ? "files.delete_folder_text" : "files.delete_file_text", { name: dialog.entries[0]!.name })
                : t("files.delete_many_text", { count: dialog.entries.length })}
            </span>
          }
          actionLabel={t("common.delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            let files = 0;
            let folders = 0;
            for (const e of dialog.entries) {
              const r = await api.files.delete(room.id, channel.id, e.id);
              files += r.files;
              folders += r.folders;
            }
            setDialog(null);
            refresh();
            useToasts.getState().push({ kind: "info", title: t("files.deleted", { files, folders }) });
          }}
        />
      )}
      {dialog?.kind === "audio" && (
        <Dialog title={dialog.entry.name} open onClose={() => setDialog(null)}>
          <AudioPlayer a={asView(dialog.entry)} />
        </Dialog>
      )}
      {viewer && (
        <Suspense fallback={null}>
          <MediaViewer items={viewer.items} start={viewer.start} onClose={() => setViewer(null)} />
        </Suspense>
      )}
    </div>
  );
}

function EntryRow(p: {
  entry: FileEntry;
  grid: boolean;
  selected: boolean;
  focused: boolean;
  owner: string | null;
  draggable: boolean;
  drag: string[];
  folderDrop?: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  onSelect: (mods: { shift?: boolean; ctrl?: boolean }) => void;
  onOpen: () => void;
  onMenu: (el: Element | null, point?: { x: number; y: number }) => void;
  load: ViewAttachment;
  menuLabel: string;
}) {
  const t = useT();
  const e = p.entry;
  const long = useRef<ReturnType<typeof setTimeout> | null>(null);
  const button = useRef<HTMLSpanElement>(null);
  const date = new Date(e.updated_at);
  const when = Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  const common = {
    id: `file-${e.id}`,
    role: "option",
    "aria-selected": p.selected,
    "data-entry": e.id,
    "data-testid": "file-row",
    "data-name": e.name,
    "data-kind": e.kind,
    draggable: p.draggable,
    onDragStart: (ev: DragEvent) => {
      ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(p.drag));
      ev.dataTransfer.effectAllowed = "move";
    },
    onClick: (ev: React.MouseEvent) => {
      ev.stopPropagation();
      p.onSelect({ shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey });
    },
    onDoubleClick: () => p.onOpen(),
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      p.onMenu(null, { x: ev.clientX, y: ev.clientY });
    },
    // A long press on touch opens the menu (the action sheet of phones).
    onTouchStart: () => {
      long.current = setTimeout(() => p.onMenu(button.current), 500);
    },
    onTouchEnd: () => long.current && clearTimeout(long.current),
    onTouchMove: () => long.current && clearTimeout(long.current),
    ...(p.folderDrop ?? {}),
  };
  // The row is an option of the list box, which must not contain other controls (WCAG 4.1.2): the menu and open
  // affordances are pointer shortcuts; keyboard and screen reader users open with Enter and get the menu with the
  // context menu key or Shift+F10 on the list.
  const menuButton = (
    <span
      ref={button}
      aria-hidden="true"
      title={p.menuLabel}
      className="inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center rounded text-fg-2 hover:bg-bg-3 hover:text-fg-0"
      data-testid="file-menu-button"
      onClick={(ev) => {
        ev.stopPropagation();
        p.onMenu(ev.currentTarget);
      }}
    >
      ⋯
    </span>
  );
  const ring = `${p.selected ? "bg-accent-soft text-fg-0" : "hover:bg-bg-3/60"} ${p.focused ? "ring-1 ring-accent" : ""}`;
  if (p.grid) {
    return (
      <div {...common} className={`group relative flex cursor-default select-none flex-col items-center gap-1 rounded-md p-2 text-center text-sm ${ring}`}>
        <Thumb entry={e} view={p.load} />
        <span className="w-full cursor-pointer truncate text-xs hover:underline" title={e.name} onClick={(ev) => { ev.stopPropagation(); p.onOpen(); }} data-testid="file-open">
          {e.name}
        </span>
        <span className="text-[11px] text-fg-2">{e.kind === "folder" ? t("files.folder") : formatBytes(e.size)}</span>
        <span className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">{menuButton}</span>
      </div>
    );
  }
  return (
    <div {...common} className={`grid min-h-11 cursor-default select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-sm md:grid-cols-[minmax(0,1fr)_7rem_9rem_9rem_2.5rem] ${ring}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="w-5 shrink-0 text-center">
          {entryIcon(e)}
        </span>
        <span className="min-w-0 cursor-pointer truncate text-left hover:underline" title={e.name} onClick={(ev) => { ev.stopPropagation(); p.onOpen(); }} data-testid="file-open">
          {e.name}
        </span>
        <span className="shrink-0 text-[11px] text-fg-2 md:hidden">{e.kind === "folder" ? "" : formatBytes(e.size)}</span>
      </span>
      <span className="hidden text-right text-xs tabular-nums text-fg-2 md:block">{e.kind === "folder" ? "—" : formatBytes(e.size)}</span>
      <span className="hidden truncate text-xs text-fg-2 md:block">{when}</span>
      <span className="hidden truncate text-xs text-fg-2 md:block">{p.owner ?? "—"}</span>
      {menuButton}
    </div>
  );
}

/** Grid tile picture: image previews where the user's auto-preview setting allows, else the icon. */
function Thumb({ entry, view }: { entry: FileEntry; view: ViewAttachment }) {
  const setting = usePrivacy((s) => s.autoPreview);
  const maxBytes = usePrivacy((s) => s.maxBytes);
  const image = entry.kind === "file" && mediaKind(entry.mime, entry.name) === "image" && !isSvg(entry.mime, entry.name);
  const auto = image && shouldAutoPreview({ setting, size: entry.size, maxBytes, own: false, inRoom: true, friend: false });
  const { url } = useAttachmentUrl(view, auto);
  if (auto && url) return <img src={url} alt="" className="h-20 w-full rounded object-cover" draggable={false} />;
  return (
    <span aria-hidden="true" className="flex h-20 w-full items-center justify-center text-4xl">
      {entryIcon(entry)}
    </span>
  );
}
