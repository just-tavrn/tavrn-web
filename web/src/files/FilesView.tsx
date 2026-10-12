// SPDX-License-Identifier: Apache-2.0
/**
 * The file browser of a files channel (design note 4.13 item 9, tavrn-protocol/FILES.md): breadcrumbs, list and grid
 * views, sorting, search, uploads by button or drag and drop with progress, new folder, rename, move (dialog
 * or dragging onto a folder), delete, download, media in the viewer, the context menu, selection with
 * Shift/Ctrl, keyboard navigation, the storage meter and the permanent "not end-to-end encrypted" banner.
 * Phones get the list only and the row menu as their action sheet.
 *
 * End-to-end encrypted channels (FILES.md §8, `./e2ee`): the channel's MLS group like a text channel, entry records
 * decrypted on this device (names, types, folder names), encrypted uploads with client-made thumbnails, downloads
 * decrypted chunk by chunk, the folder filter instead of the node's search, the decrypted entries in the local search
 * index, the lock state of the message list ("Your files" when nothing can be decrypted) and the SVG lock in the
 * header.
 */
import { useGhostGate } from "../components/GhostGate";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { Channel, FileEntry, FilesInfo, RoomDetail } from "@tavrn/sdk";
import { decryptFileRecord, parseHistoryPolicy, qualify, type FileRecord, type FileRecordResult } from "@tavrn/e2ee";
import { historyPending, historyReceive } from "../crypto/history";
import { useE2eeConversation } from "../hooks/useE2eeConversation";
import { LockMark } from "../components/Badges";
import { E2eeStatusLine, LockedNotice } from "../components/E2eeNotices";
import { indexMessages, unindexMessages } from "../search/local";
import { rememberFilesChannel } from "../search/sync";
import { registerFilesChannel, useHistoryKeys } from "./registry";
import { YourFilesDialog, YourFilesPanel } from "./YourFiles";
import {
  createFolderEncrypted,
  decryptRecords,
  displayEntries,
  fileIndexEntries,
  filesLockState,
  loadEncrypted,
  renameEncrypted,
  thumbnailUrl,
  uniqueName,
  uploadEncrypted,
  type EncryptedContext,
} from "./e2ee";
import { useLocale, useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { useNodeSockets, useRealtimeState } from "../hooks/useRealtime";
import { ContextMenu, menuItem, normalizeMenu, separator, type MenuEntry } from "../components/ContextMenu";
import { pointAnchor, rectOf, type AnchorRect } from "../lib/position";
import { AudioPlayer, mediaKind, useAttachmentUrl, type ViewAttachment } from "../components/AttachmentView";
import { saveDownload } from "../lib/download";
import { Button, Dialog } from "../components/ui";
import { ConfirmDialog } from "../pages/settings/common";
import { useRoomMembers } from "../pages/ChannelPage";
import { channelName } from "../lib/names";
import { memberName } from "../lib/memberGroups";
import { isSvg, shouldAutoPreview } from "../lib/preview";
import { usePrivacy } from "../stores/privacy";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { MoveDialog, NameDialog } from "./dialogs";
import { HistoryRestoreBanner } from "../components/HistoryRestoreBanner";
import {
  DEFAULT_SORT,
  DRAG_TYPE,
  EMPTY_SELECTION,
  canModify,
  entryIcon,
  externalBackend,
  formatBytes,
  moveFocus,
  needsStore,
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
  const { api, domain, home, me, roomPath } = useNode();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder");
  // End-to-end encrypted channel (FILES.md §8): records instead of names, the channel's MLS group.
  const encrypted = channel.encrypted;
  const q = qualify(domain, channel.id);
  const [yourFiles, setYourFiles] = useState(false);
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

  // Encrypted channels: the node cannot search, the box filters the decrypted folder (the global search covers the
  // channel through the local index, SEARCH.md §3.6).
  const nodeSearch = encrypted ? "" : search;
  const filesKey = ["files", domain, channel.id] as const;
  const listing = useInfiniteQuery({
    queryKey: [...filesKey, nodeSearch ? null : folder, nodeSearch],
    queryFn: ({ pageParam }) => api.files.list(room.id, channel.id, { parent: nodeSearch ? null : folder, q: nodeSearch || undefined, after: pageParam, limit: 100 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_after ?? undefined,
  });
  const info = useQuery({ queryKey: ["files-usage", domain, channel.id], queryFn: () => api.files.usage(room.id, channel.id) });
  const members = useRoomMembers(room.id);
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.user.id, memberName(m)])), [members.data]);
  const addresses = useMemo(() => new Map((members.data ?? []).map((m) => [m.user.id, m.user.address])), [members.data]);
  const memberAddresses = useMemo(() => (members.data ? members.data.map((m) => m.user.address) : null), [members.data]);
  const e2ee = useE2eeConversation({ conversationId: q, encrypted, canCreate: !!info.data?.can_upload, members: memberAddresses, mayManage: false });
  // File records (keys and names) are not encrypted while a ghost leaf is not acknowledged (ENCRYPTION.md §4.6).
  const gate = useGhostGate(q, e2ee, encrypted);
  useEffect(() => (encrypted ? registerFilesChannel(q, room.id) : undefined), [encrypted, q, room.id]);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: filesKey });
    void queryClient.invalidateQueries({ queryKey: ["files-usage", domain, channel.id] });
    void queryClient.invalidateQueries({ queryKey: ["files-move", domain, channel.id] });
    // `filesKey` is derived from domain and channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, domain, channel.id]);
  useFilesRealtime(domain, home, channel.id, refresh);

  const raw = useMemo(() => listing.data?.pages.flatMap((p) => p.entries) ?? [], [listing.data]);
  const rawPath = useMemo(() => (nodeSearch ? [] : (listing.data?.pages[0]?.path ?? [])), [listing.data, nodeSearch]);
  // Records of the listed entries and of the folder chain, decrypted on this device (cached by the manager).
  const [records, setRecords] = useState<Map<string, FileRecordResult>>(() => new Map());
  // History for new members (ENCRYPTION.md §7b, FILES.md §8.7): take shared keys, share ours with members who wait.
  const [keysArrived, setKeysArrived] = useState(0);
  const historyKeys = useHistoryKeys((s) => s.version);
  const historyPolicy = useMemo(() => (encrypted ? parseHistoryPolicy(channel.history_for_new_members) : null), [encrypted, channel.history_for_new_members]);
  useEffect(() => {
    if (!historyPolicy || e2ee.phase !== "ready") return;
    void historyReceive(q).then((n) => n > 0 && setKeysArrived((k) => k + 1));
    historyPending(q, historyPolicy);
  }, [historyPolicy, e2ee.phase, q]);
  useEffect(() => {
    if (!encrypted || !e2ee.mls) return;
    let stale = false;
    const mls = e2ee.mls;
    void (async () => {
      const crumbEntries = rawPath.map((c) => ({ ...c, kind: "folder", size: 0 }));
      const next = await decryptRecords(mls, q, raw);
      for (const c of crumbEntries) next.set(c.id, await decryptFileRecord(mls, q, c).catch(() => ({ ok: false, reason: "invalid" }) as const));
      if (!stale) setRecords(next);
    })();
    return () => {
      stale = true;
    };
  }, [encrypted, e2ee.mls, e2ee.tick, q, raw, rawPath, keysArrived, historyKeys]);
  const recordOf = useCallback((id: string): FileRecord | null => {
    const r = records.get(id);
    return r?.ok ? r.record : null;
  }, [records]);
  const lockState = encrypted ? filesLockState(e2ee.phase, records) : null;
  // `t` is a new function on every render: the labels change with the language only.
  const locale = useLocale((s) => s.locale);
  const lockedLabels = useMemo(() => ({ file: t("files.locked_file"), folder: t("files.locked_folder") }), [locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownRaw = useMemo(() => (encrypted ? displayEntries(raw, records, lockedLabels) : raw), [encrypted, raw, records, lockedLabels]);
  const entries = useMemo(() => {
    const needle = encrypted ? search.toLowerCase() : "";
    return sortEntries(needle ? shownRaw.filter((e) => e.name.toLowerCase().includes(needle)) : shownRaw, sort);
  }, [shownRaw, sort, encrypted, search]);
  const order = useMemo(() => entries.map((e) => e.id), [entries]);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const rawById = useMemo(() => new Map(raw.map((e) => [e.id, e])), [raw]);
  const path = useMemo(() => (encrypted ? rawPath.map((c) => ({ ...c, name: recordOf(c.id)?.name ?? lockedLabels.folder })) : rawPath), [encrypted, rawPath, recordOf, lockedLabels]);
  // The local search index gets every entry this device decrypted (SEARCH.md §3.6), once per record.
  const indexed = useRef(new Set<string>());
  useEffect(() => {
    if (!encrypted || nodeSearch) return;
    const fresh = raw.filter((e) => records.get(e.id)?.ok && !indexed.current.has(`${e.id}|${e.record_at ?? ""}|${e.parent_id ?? ""}`));
    if (!fresh.length) return;
    const folderPath = path.map((c) => c.name).join("/");
    const docs = fileIndexEntries(q, room.id, fresh, records, () => folderPath, (e) => (e.created_by ? addresses.get(e.created_by) : undefined) ?? e.record_author ?? "");
    for (const e of fresh) indexed.current.add(`${e.id}|${e.record_at ?? ""}|${e.parent_id ?? ""}`);
    void indexMessages(docs).then(() => rememberFilesChannel(q, room.id));
  }, [encrypted, nodeSearch, raw, records, path, q, room.id, addresses]);
  // A search result opens the folder with its entry selected (`?entry=`).
  const wanted = params.get("entry");
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || !byId.has(wanted) || handled.current === wanted) return;
    handled.current = wanted;
    setSelection(selectWith(EMPTY_SELECTION, order, wanted));
    setFocus(wanted);
    listRef.current?.querySelector<HTMLElement>(`[data-entry="${wanted}"]`)?.scrollIntoView({ block: "nearest" });
    const next = new URLSearchParams(params);
    next.delete("entry");
    setParams(next, { replace: true });
    // Once per wanted entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, byId]);
  // A search result whose entry is gone: it leaves the local index (SEARCH.md §3.6).
  useEffect(() => {
    if (!encrypted || !wanted || !listing.isSuccess || listing.hasNextPage || byId.has(wanted)) return;
    let stale = false;
    void api.files.get(room.id, channel.id, wanted).catch((e: unknown) => {
      if (stale || (e as { status?: number }).status !== 404) return;
      void unindexMessages(q, [wanted]);
      useToasts.getState().push({ kind: "info", title: t("files.entry_gone") });
    });
    return () => {
      stale = true;
    };
    // `t` is left out on purpose (a new function per render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encrypted, wanted, listing.isSuccess, listing.hasNextPage, byId, api, room.id, channel.id, q]);
  const decryptFolderNames = useCallback(
    async (list: Parameters<typeof decryptRecords>[2]) => {
      const out = new Map<string, string>();
      if (!e2ee.mls) return out;
      for (const [id, r] of await decryptRecords(e2ee.mls, q, list)) if (r.ok) out.set(id, r.record.name);
      return out;
    },
    [e2ee.mls, q],
  );
  const ctx = (): EncryptedContext | null => {
    if (gate.blocked) throw new Error(t("e2ee.composer_ghost"));
    return e2ee.mls ? { api, mls: e2ee.mls, conversation: q, roomId: room.id, channelId: channel.id } : null;
  };
  useEffect(() => setSelection((s) => pruneSelection(s, order)), [order]);
  useEffect(() => {
    if (params.get("entry")) return;
    setSelection(EMPTY_SELECTION);
    setFocus(null);
    // Reset when the folder or the search changes, not when the wanted entry is consumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** The content of an entry: plain from the node, or decrypted chunk by chunk with the record's key. */
  const loadEntry = (e: FileEntry): Promise<Blob> => {
    if (!encrypted) return api.files.download(room.id, channel.id, e.id);
    const record = recordOf(e.id);
    const stored = rawById.get(e.id);
    if (!record || !stored) return Promise.reject(new Error(t("files.cannot_decrypt")));
    return loadEncrypted(api, room.id, channel.id, stored, record);
  };
  const asView = (e: FileEntry): ViewAttachment => ({ id: e.id, name: e.name, mime: e.mime, size: e.size, encrypted: null, load: () => loadEntry(e) });

  const download = async (e: FileEntry) => {
    try {
      // Saved as opaque bytes: the browser never renders a file of the channel. Executables ask first.
      await saveDownload({ name: e.name, data: await loadEntry(e), mime: "application/octet-stream" }, e.mime);
    } catch (err) {
      toastError(err);
    }
  };

  const open = (e: FileEntry) => {
    if (encrypted && !recordOf(e.id)) return toastError(new Error(t("files.cannot_decrypt")));
    if (e.kind === "folder") return openFolder(e.id);
    const kind = mediaKind(e.mime, e.name);
    if (kind === "image" || kind === "video") {
      const visual = entries.filter((x) => x.kind === "file" && ["image", "video"].includes(mediaKind(x.mime, x.name)));
      setViewer({ items: visual.map(asView), start: visual.findIndex((x) => x.id === e.id) });
    } else if (kind === "audio") setDialog({ kind: "audio", entry: e });
    else void download(e);
  };

  // ---------------------------------------------------------------- Uploads

  /** Names in a folder (encrypted channels: decrypted; the node cannot check uniqueness, FILES.md §8.5). */
  const namesIn = async (target: string | null): Promise<string[]> => {
    if (target === (search ? null : folder) && !search) return shownRaw.map((e) => e.name);
    const all: FileEntry[] = [];
    let after: string | null = null;
    do {
      const page = await api.files.list(room.id, channel.id, { parent: target, after, limit: 200 });
      all.push(...page.entries);
      after = page.next_after ?? null;
    } while (after);
    const res = e2ee.mls ? await decryptRecords(e2ee.mls, q, all) : new Map<string, FileRecordResult>();
    return [...res.values()].flatMap((r) => (r.ok ? [r.record.name] : []));
  };

  const uploadFiles = async (files: File[], target: string | null = search ? null : folder) => {
    if (!i) return;
    if (encrypted && gate.blocked) return toastError(new Error(t("e2ee.composer_ghost")));
    const enc = encrypted ? ctx() : null;
    if (encrypted && !enc) return toastError(new Error(t("files.e2ee_not_ready")));
    const taken = enc ? await namesIn(target).catch(() => [] as string[]) : [];
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
        const onProgress = (p: number) => dispatchUploads({ type: "progress", key: item.key, progress: p });
        if (enc) {
          const name = uniqueName(item.name.normalize("NFC").trim(), taken);
          taken.push(name);
          await uploadEncrypted(enc, item.file, { parentId: target, name, signal: abort.signal, onProgress });
        } else await api.files.upload(room.id, channel.id, item.file, item.name, { parentId: target, rename: true, signal: abort.signal, onProgress });
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
  const external = i && externalBackend(i.backend);
  // A node without its own storage for files channels: no uploads until the channel has an external store.
  const storeMissing = needsStore(i);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-view" onDragOver={onDragOver} onDragLeave={() => setDropActive(false)} onDrop={onDrop}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="text-fg-2" aria-hidden="true">
          📁
        </span>
        <h1 className="min-w-0 truncate text-sm font-semibold" data-testid="channel-name">
          {channelName(channel)}
        </h1>
        {encrypted && <LockMark size={18} title={t("files.e2ee_hint")} testId="encrypted-marker" />}
        {channel.topic && <span className="hidden truncate text-sm text-fg-2 md:inline">· {channel.topic}</span>}
        <span className="flex-1" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={encrypted ? t("files.filter") : t("files.search")}
          aria-label={encrypted ? t("files.filter") : t("files.search")}
          className="h-8 w-28 min-w-0 rounded-md border border-line-strong bg-bg-0 px-2 text-sm outline-none focus:border-accent sm:w-48"
          data-testid="files-search"
        />
      </header>
      {/* Permanent for unencrypted files channels (PROTOCOL.md §8, FILES.md §1). */}
      {!encrypted && (
        <div role="status" data-testid="files-banner" data-backend={i?.backend ?? "internal"} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn">
          <LockMark open size={16} />
          <span>{t("files.banner")}</span>
          {external && <span data-testid="files-banner-external">{t(i.encrypt_files ? "files.banner_external_encrypted" : "files.banner_external", { kind: t(`files.backend.${i.backend}`) })}</span>}
        </div>
      )}
      {encrypted && external && (
        <p className="border-b border-line px-4 py-1.5 text-xs text-fg-2" data-testid="files-banner-external">
          {t("files.banner_external_e2ee", { kind: t(`files.backend.${i.backend}`) })}
        </p>
      )}
      {encrypted && lockState === "locked" && <LockedNotice />}
      {gate.warning}
      {encrypted && (lockState === "joining" || lockState === "no_group" || lockState === "error") && <E2eeStatusLine kind={lockState} detail={e2ee.error ?? undefined} />}
      {encrypted && lockState === "missing_keys" && (
        <p role="status" className="border-b border-line bg-bg-1 px-4 py-2 text-sm text-fg-1" data-testid="files-missing-keys">
          {t("files.missing_keys")}
        </p>
      )}
      {/* History restore after a key reset (ENCRYPTION.md §7b): the requester's banner, next to the states above when
          entries cannot be decrypted. */}
      {encrypted && <HistoryRestoreBanner room={room} />}
      {/* The breadcrumbs keep a minimum width and the toolbar wraps below them (and within itself) on narrow screens or
          with wide fonts: a toolbar that cannot fit must never be laid over the crumbs. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <nav aria-label={t("files.breadcrumbs")} className="flex min-w-32 flex-1 flex-wrap items-center gap-1 text-sm" data-testid="files-breadcrumbs">
          {search ? (
            <span className="text-fg-1" data-testid="files-search-results">
              {t("files.results_for", { query: search })}
            </span>
          ) : (
            <>
              <button type="button" onClick={() => openFolder(null)} className="min-h-6 min-w-6 rounded px-1 font-medium text-fg-1 hover:bg-bg-3 hover:text-fg-0" data-testid="files-crumb" data-folder="" {...rootDrop}>
                {channelName(channel)}
              </button>
              {path.map((c) => (
                <span key={c.id} className="flex min-w-0 items-center gap-1">
                  <span className="text-fg-2">/</span>
                  <button type="button" onClick={() => openFolder(c.id)} className="min-h-6 min-w-6 max-w-[12rem] truncate rounded px-1 text-fg-1 hover:bg-bg-3 hover:text-fg-0" data-testid="files-crumb" data-folder={c.id}>
                    {c.name}
                  </button>
                </span>
              ))}
            </>
          )}
        </nav>
        <div className="flex flex-wrap items-center gap-1" data-testid="files-toolbar">
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
          {encrypted && (
            <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setYourFiles(true)} data-testid="files-your-files">
              {t("files.your_files")}
            </Button>
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
          {storeMissing &&
            (i?.can_configure ? (
              <Link
                to={roomPath(room.id, undefined, `settings/channels?channel=${encodeURIComponent(channel.id)}`)}
                className="inline-flex min-h-8 items-center rounded-md bg-accent px-2 text-xs font-medium text-accent-text hover:bg-accent-hover"
                data-testid="files-choose-store"
              >
                {t("files.choose_store")}
              </Link>
            ) : (
              <span className="px-1 text-xs font-medium text-fg-1" data-testid="files-choose-store">
                {t("files.choose_store")}
              </span>
            ))}
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
        {encrypted && lockState === "locked" && <YourFilesPanel roomId={room.id} channelId={channel.id} onChanged={refresh} />}
        {listing.isPending && <p className="p-4 text-sm text-fg-2">{t("common.loading")}</p>}
        {listing.isError && <p className="p-4 text-sm text-danger">{describeError(listing.error)}</p>}
        {listing.isSuccess && entries.length === 0 && lockState !== "locked" && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-fg-2" data-testid="files-empty">
            <span aria-hidden="true" className="text-4xl">
              {search ? "🔍" : "📂"}
            </span>
            <p>{search ? t("files.no_results") : storeMissing ? t("files.no_store") : canUpload ? t("files.empty_upload") : t("files.empty")}</p>
          </div>
        )}
        {entries.length > 0 && lockState !== "locked" && view === "list" && (
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
                thumb={encrypted ? (recordOf(e.id) ? { record: recordOf(e.id)!, roomId: room.id, channelId: channel.id } : null) : undefined}
                locked={encrypted && !recordOf(e.id)}
                menuLabel={t("files.menu", { name: e.name })}
              />
            ))}
          </div>
        )}
        {entries.length > 0 && lockState !== "locked" && view === "grid" && (
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
                thumb={encrypted ? (recordOf(e.id) ? { record: recordOf(e.id)!, roomId: room.id, channelId: channel.id } : null) : undefined}
                locked={encrypted && !recordOf(e.id)}
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
          pending={encrypted && lockState === "joining" ? t("files.e2ee_not_ready") : undefined}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const enc = encrypted ? ctx() : null;
            if (encrypted && !enc) throw new Error(t("files.e2ee_not_ready"));
            if (enc) {
              if (shownRaw.some((e) => e.name.toLowerCase() === name.normalize("NFC").trim().toLowerCase())) throw new Error(t("files.name_taken", { name }));
              await createFolderEncrypted(enc, name, search ? null : folder);
            } else await api.files.createFolder(room.id, channel.id, name, search ? null : folder);
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
          pending={encrypted && lockState === "joining" ? t("files.e2ee_not_ready") : undefined}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const enc = encrypted ? ctx() : null;
            const record = recordOf(dialog.entry.id);
            if (encrypted && (!enc || !record)) throw new Error(t("files.e2ee_not_ready"));
            if (enc && record) {
              const clean = name.normalize("NFC").trim().toLowerCase();
              if (shownRaw.some((e) => e.id !== dialog.entry.id && e.name.toLowerCase() === clean)) throw new Error(t("files.name_taken", { name }));
              await renameEncrypted(enc, dialog.entry, record, name);
            } else await api.files.update(room.id, channel.id, dialog.entry.id, { name });
            refresh();
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveDialog
          open
          roomId={room.id}
          channelId={channel.id}
          moving={dialog.entries}
          onClose={() => setDialog(null)}
          onMove={(target) => moveEntries(dialog.entries, target)}
          decryptNames={encrypted && e2ee.mls ? decryptFolderNames : undefined}
        />
      )}
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
            // Deleted entries leave the local search index (SEARCH.md §3.6).
            if (encrypted) void unindexMessages(q, dialog.entries.map((e) => e.id));
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
      {yourFiles && <YourFilesDialog roomId={room.id} channelId={channel.id} onClose={() => setYourFiles(false)} onChanged={refresh} />}
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
  /** Encrypted channels: the record for the client-made thumbnail (null: unreadable). */
  thumb?: { record: FileRecord; roomId: string; channelId: string } | null;
  /** Encrypted channels: the record cannot be decrypted on this device. */
  locked?: boolean;
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
    "data-locked": p.locked ? "true" : undefined,
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
        {p.thumb !== undefined ? <EncryptedThumb entry={e} thumb={p.thumb} /> : <Thumb entry={e} view={p.load} />}
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
          {p.locked ? <LockMark size={14} /> : entryIcon(e)}
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

/** Grid tile picture of an encrypted channel: the client-made thumbnail, decrypted once per session, else the icon. */
function EncryptedThumb({ entry, thumb }: { entry: FileEntry; thumb: { record: FileRecord; roomId: string; channelId: string } | null }) {
  const { api } = useNode();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!thumb?.record.thumbnail) return;
    let stale = false;
    void thumbnailUrl(api, thumb.roomId, thumb.channelId, entry, thumb.record).then((u) => !stale && setUrl(u));
    return () => {
      stale = true;
    };
    // The record's key and the entry id identify the thumbnail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, thumb?.record.key, entry.id]);
  if (url) return <img src={url} alt="" className="h-20 w-full rounded object-cover" draggable={false} data-testid="file-thumbnail" />;
  return (
    <span aria-hidden="true" className="flex h-20 w-full items-center justify-center text-4xl">
      {thumb ? entryIcon(entry) : <LockMark size={28} />}
    </span>
  );
}
