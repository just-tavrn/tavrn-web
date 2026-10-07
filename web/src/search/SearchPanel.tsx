// SPDX-License-Identifier: Apache-2.0
/**
 * The search box (design note 4.4 "Search"): in the conversation header a search field on desktop and a search
 * icon on phones; both open the panel (anchored below the header on desktop, full screen on phones). One
 * query searches the node (unencrypted channels) and the local encrypted index (encrypted channels and DMs);
 * the status line says what was searched. Scopes: this room (or this conversation for DMs) and everywhere
 * (all rooms on all nodes, at most 20 rooms, plus everything the local index holds).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { create } from "zustand";
import { qualify } from "@tavrn/e2ee";
import type { Conversation, Member, Room, RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { formatTime } from "../lib/format";
import { channelName } from "../lib/names";
import { conversationPath, roomPath, useNode } from "../components/NodeScope";
import { apiFor, homeDomain, isHome, useNodes } from "../stores/nodes";
import { localIndex, useLocalSearch } from "./local";
import { MAX_ROOMS, runSearch, searchable, snippetParts, type Filters, type LocalRef, type RoomRef, type Scope, type SearchRow, type SearchStatus } from "./combined";

interface SearchUi {
  open: boolean;
  query: string;
  scope: Scope;
  filters: Filters;
  rows: SearchRow[] | null;
  status: SearchStatus | null;
  busy: boolean;
  /** Where the last search ran (results of another room are cleared when the scope is "room"). */
  context: string;
  set: (patch: Partial<Omit<SearchUi, "set">>) => void;
}

/** Survives navigation between conversations (the panel stays open on desktop while jumping). */
export const useSearchUi = create<SearchUi>((set) => ({
  open: false,
  query: "",
  scope: "room",
  filters: {},
  rows: null,
  status: null,
  busy: false,
  context: "",
  set: (patch) => set(patch),
}));

const wide = () => typeof window !== "undefined" && window.matchMedia?.("(min-width: 768px)").matches;

/** Highlighted snippet: the markers become <mark>, everything else is plain text. */
export function Snippet({ text }: { text: string }) {
  return (
    <span className="break-words text-sm text-fg-1" data-testid="search-snippet">
      {snippetParts(text).map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded bg-accent-soft px-0.5 text-fg-0">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

/** The honest status line ("searched … ; … not synced yet"). */
export function statusText(s: SearchStatus, scope: Scope, t: ReturnType<typeof useT>): string {
  const parts: string[] = [];
  if (scope !== "conversation") {
    parts.push(t("search.status.node", { channels: s.nodeChannels, rooms: s.nodeRooms }));
    if (s.roomsSkipped > 0) parts.push(t("search.status.rooms_skipped", { count: s.roomsSkipped, max: MAX_ROOMS }));
    if (s.nodeFailed > 0) parts.push(t("search.status.node_failed", { count: s.nodeFailed }));
  }
  if (s.localLocked) parts.push(t("search.status.local_locked"));
  else {
    const window = s.localSearched - s.localComplete;
    if (window > 0) parts.push(t("search.status.local_window", { days: s.windowDays, count: window }));
    if (s.localComplete > 0) parts.push(t("search.status.local_complete", { count: s.localComplete }));
    if (s.localNotSynced > 0) parts.push(t("search.status.local_not_synced", { count: s.localNotSynced }));
    if (s.localSearched === 0 && s.localNotSynced === 0) parts.push(t("search.status.local_none"));
  }
  return parts.join(" · ");
}

export function SearchButton(p: { conversationId: string; encrypted: boolean; roomId?: string; room?: RoomDetail; members?: Member[] }) {
  const t = useT();
  const ui = useSearchUi();
  const open = () => {
    ui.set({ open: true, scope: p.roomId ? (ui.scope === "conversation" ? "room" : ui.scope) : ui.scope === "room" ? "conversation" : ui.scope });
  };
  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={t("search.open")}
        aria-expanded={ui.open}
        data-testid="search-open"
        className="inline-flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0 md:min-w-48 md:justify-start md:border md:border-line md:bg-bg-1 md:px-3 md:text-sm"
      >
        <span aria-hidden="true">🔍</span>
        <span className="hidden truncate md:inline">{ui.query || t("search.placeholder")}</span>
      </button>
      {ui.open && <SearchPanel {...p} />}
    </>
  );
}

function SearchPanel(p: { conversationId: string; encrypted: boolean; roomId?: string; room?: RoomDetail; members?: Member[] }) {
  const t = useT();
  const ui = useSearchUi();
  const { domain, api } = useNode();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const coverage = useLocalSearch((s) => s.coverage);
  const sessions = useNodes((s) => s.sessions);
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(-1);
  const [showFilters, setShowFilters] = useState(false);
  const context = ui.scope === "everywhere" ? "everywhere" : ui.scope === "room" ? `room:${p.roomId}` : `conv:${p.conversationId}`;

  useEffect(() => inputRef.current?.focus(), []);
  // Results of another room or conversation do not belong here.
  useEffect(() => {
    if (ui.context && ui.context !== context && ui.scope !== "everywhere") ui.set({ rows: null, status: null, context: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  const textChannels = useMemo(() => (p.room?.channels ?? []).filter((c) => !["voice", "files", "system"].includes(c.kind)), [p.room]);
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const [, room] of queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] })) {
      for (const c of room?.channels ?? []) names.set(c.id, `#${channelName(c)}`);
    }
    for (const c of textChannels) names.set(c.id, `#${channelName(c)}`);
    return names;
  }, [queryClient, textChannels, ui.rows]);
  const authorName = useMemo(() => new Map((p.members ?? []).map((m) => [m.user.address, m.nick || m.user.display_name])), [p.members]);

  const close = () => ui.set({ open: false });

  const run = async () => {
    const { query, filters, scope } = useSearchUi.getState();
    if (!searchable(query, filters)) {
      ui.set({ rows: [], status: null, context });
      return;
    }
    ui.set({ busy: true });
    setActive(-1);
    try {
      let rooms: RoomRef[] = [];
      let local: LocalRef[] | null = [];
      let roomsSkipped = 0;
      if (scope === "room" && p.roomId) {
        rooms = [{ node: domain, roomId: p.roomId, api }];
        local = textChannels.filter((c) => c.encrypted).map((c) => ({ node: domain, conversationId: c.id, roomId: p.roomId }));
      } else if (scope === "conversation") {
        local = p.encrypted ? [{ node: domain, conversationId: p.conversationId }] : [];
      } else {
        // Everywhere: the rooms of every node with a session (home first), at most MAX_ROOMS; the local index whole.
        const home = homeDomain() ?? domain;
        const nodes = [home, ...Object.keys(sessions).filter((d) => !isHome(d))];
        const all: { node: string; room: Room }[] = [];
        for (const node of nodes) {
          const list = await queryClient
            .fetchQuery({ queryKey: isHome(node) ? ["rooms"] : ["rooms", node], queryFn: () => apiFor(isHome(node) ? null : node).rooms.list(), staleTime: 60_000 })
            .catch(() => [] as Room[]);
          for (const room of list) all.push({ node, room });
        }
        roomsSkipped = Math.max(0, all.length - MAX_ROOMS);
        rooms = all.slice(0, MAX_ROOMS).map(({ node, room }) => ({ node, roomId: room.id, api: apiFor(isHome(node) ? null : node) }));
        // Not synced yet: encrypted channels of rooms whose details are loaded and encrypted DMs of the loaded lists.
        const known: LocalRef[] = [];
        for (const [, room] of queryClient.getQueriesData<RoomDetail>({ queryKey: ["room"] })) {
          const node = all.find((r) => r.room.id === room?.id)?.node ?? home;
          for (const c of room?.channels ?? []) if (c.encrypted && !["voice", "files", "system"].includes(c.kind)) known.push({ node, conversationId: c.id, roomId: room!.id });
        }
        for (const [key, list] of queryClient.getQueriesData<Conversation[]>({ queryKey: ["conversations"] })) {
          const node = typeof key[1] === "string" ? key[1] : home;
          for (const c of Array.isArray(list) ? list : []) if (c.encrypted) known.push({ node, conversationId: c.id });
        }
        local = null;
        const index = await localIndex();
        const result = await runSearch({ query, filters, rooms, local, roomsSkipped }, index, coverage);
        // The status counts the known encrypted conversations (searched or not synced yet).
        const knownQs = new Set(known.map((k) => qualify(k.node, k.conversationId)));
        for (const q of Object.keys(coverage)) knownQs.add(q);
        const synced = [...knownQs].filter((q) => coverage[q]?.sync.done || (coverage[q]?.complete && coverage[q]?.sync.reachedStart));
        result.status.localSearched = synced.length;
        result.status.localComplete = [...knownQs].filter((q) => coverage[q]?.complete).length;
        result.status.localNotSynced = knownQs.size - synced.length;
        ui.set({ rows: result.rows, status: result.status, busy: false, context });
        return;
      }
      const index = await localIndex();
      const result = await runSearch({ query, filters, rooms, local, roomsSkipped }, index, coverage);
      ui.set({ rows: result.rows, status: result.status, busy: false, context });
    } catch {
      ui.set({ rows: [], status: null, busy: false, context });
    }
  };

  const openRow = (row: SearchRow) => {
    const node = isHome(row.node) ? null : row.node;
    const path = row.roomId ? roomPath(node, row.roomId, row.conversationId) : conversationPath(node, row.conversationId);
    navigate(`${path}?m=${row.messageId}`);
    if (!wide()) close();
  };

  const rows = ui.rows ?? [];
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp" && rows.length) {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      if (active >= 0 && rows[active]) openRow(rows[active]);
      else void run();
    }
  };
  useEffect(() => {
    if (active >= 0) document.getElementById(`search-row-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const scopes: { id: Scope; label: string }[] = [
    p.roomId ? { id: "room", label: t("search.scope.room") } : { id: "conversation", label: t("search.scope.conversation") },
    { id: "everywhere", label: t("search.scope.everywhere") },
  ];
  const setFilter = (patch: Partial<Filters>) => ui.set({ filters: { ...ui.filters, ...patch } });
  const filterCount = [ui.filters.channel, ui.filters.author, ui.filters.from, ui.filters.to, ui.filters.hasFile].filter(Boolean).length;

  return (
    <div
      role="dialog"
      aria-label={t("search.title")}
      data-testid="search-panel"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex flex-col bg-bg-0 md:absolute md:inset-auto md:right-2 md:top-12 md:max-h-[75vh] md:w-[30rem] md:rounded-lg md:border md:border-line md:shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line p-2">
        <span aria-hidden="true" className="pl-1 text-fg-2">
          🔍
        </span>
        <input
          ref={inputRef}
          type="search"
          value={ui.query}
          maxLength={256}
          onChange={(e) => ui.set({ query: e.target.value })}
          placeholder={t("search.placeholder")}
          aria-label={t("search.input")}
          aria-controls="search-results"
          aria-activedescendant={active >= 0 ? `search-row-${active}` : undefined}
          className="min-h-10 min-w-0 flex-1 rounded-md bg-bg-1 px-3 text-sm text-fg-0 outline-none focus:ring-2 focus:ring-accent"
          data-testid="search-input"
        />
        <button type="button" onClick={() => void run()} className="min-h-10 rounded-md bg-accent px-3 text-sm font-medium text-accent-text hover:bg-accent-hover" data-testid="search-submit">
          {t("search.submit")}
        </button>
        <button type="button" onClick={close} aria-label={t("search.close")} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" data-testid="search-close">
          ×
        </button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5 text-xs">
        <div role="radiogroup" aria-label={t("search.scope.label")} className="flex rounded-md border border-line">
          {scopes.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={ui.scope === s.id}
              onClick={() => ui.set({ scope: s.id, rows: null, status: null })}
              className="min-h-8 px-2 text-fg-1 aria-checked:bg-accent-soft aria-checked:text-fg-0"
              data-testid={`search-scope-${s.id}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} className="min-h-8 rounded-md px-2 text-fg-2 hover:bg-bg-3 hover:text-fg-0" data-testid="search-filters-toggle">
          {t("search.filters")}
          {filterCount > 0 ? ` (${filterCount})` : ""}
        </button>
      </div>
      {showFilters && (
        <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-line p-2 text-xs" data-testid="search-filters">
          {ui.scope === "room" && textChannels.length > 0 && (
            <label className="col-span-2 flex flex-col gap-1 text-fg-2">
              {t("search.filter.channel")}
              <select value={ui.filters.channel ?? ""} onChange={(e) => setFilter({ channel: e.target.value || undefined })} className="min-h-9 rounded-md bg-bg-1 px-2 text-sm text-fg-0" data-testid="search-filter-channel">
                <option value="">{t("search.filter.all_channels")}</option>
                {textChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{channelName(c)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="col-span-2 flex flex-col gap-1 text-fg-2">
            {t("search.filter.author")}
            <input
              value={ui.filters.author ?? ""}
              onChange={(e) => setFilter({ author: e.target.value || undefined })}
              list="search-authors"
              placeholder="name@node.example"
              className="min-h-9 rounded-md bg-bg-1 px-2 text-sm text-fg-0"
              data-testid="search-filter-author"
            />
            <datalist id="search-authors">
              {(p.members ?? []).map((m) => (
                <option key={m.user.address} value={m.user.address}>
                  {m.nick || m.user.display_name}
                </option>
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-fg-2">
            {t("search.filter.from")}
            <input type="date" value={ui.filters.from ?? ""} onChange={(e) => setFilter({ from: e.target.value || undefined })} className="min-h-9 rounded-md bg-bg-1 px-2 text-sm text-fg-0" data-testid="search-filter-from" />
          </label>
          <label className="flex flex-col gap-1 text-fg-2">
            {t("search.filter.to")}
            <input type="date" value={ui.filters.to ?? ""} onChange={(e) => setFilter({ to: e.target.value || undefined })} className="min-h-9 rounded-md bg-bg-1 px-2 text-sm text-fg-0" data-testid="search-filter-to" />
          </label>
          <label className="col-span-2 flex min-h-9 items-center gap-2 text-sm text-fg-1">
            <input type="checkbox" checked={!!ui.filters.hasFile} onChange={(e) => setFilter({ hasFile: e.target.checked || undefined })} data-testid="search-filter-file" />
            {t("search.filter.has_file")}
          </label>
          {filterCount > 0 && (
            <button type="button" onClick={() => ui.set({ filters: {} })} className="col-span-2 min-h-8 justify-self-start rounded-md px-2 text-fg-2 hover:bg-bg-3 hover:text-fg-0">
              {t("search.filter.clear")}
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {ui.busy && <p className="p-3 text-sm text-fg-2">{t("search.searching")}</p>}
        {!ui.busy && ui.rows && rows.length === 0 && <p className="p-3 text-sm text-fg-2" data-testid="search-empty">{t("search.no_results")}</p>}
        <ul id="search-results" role="listbox" aria-label={t("search.results")} className="divide-y divide-line" data-testid="search-results">
          {rows.map((row, i) => (
            <li
              key={row.key}
              id={`search-row-${i}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onClick={() => openRow(row)}
              onMouseEnter={() => setActive(i)}
              className="cursor-pointer px-3 py-2 hover:bg-bg-3/60 aria-selected:bg-bg-3"
              data-testid="search-result"
              data-source={row.source}
              data-message-id={row.messageId}
            >
              <div className="flex items-baseline gap-2 text-xs text-fg-2">
                <span className="truncate font-semibold text-fg-0" data-testid="search-result-author">
                  {authorName.get(row.author) || row.author.split("@")[0]}
                </span>
                <span className="truncate">{row.roomId ? (nameOf.get(row.conversationId) ?? "#…") : t("search.dm")}</span>
                <span className="ml-auto shrink-0">{formatTime(new Date(row.ts).toISOString())}</span>
                {row.source === "local" && (
                  <span role="img" aria-label={t("search.local_hint")} title={t("search.local_hint")}>
                    🔒
                  </span>
                )}
              </div>
              <Snippet text={row.snippet} />
              {row.files.length > 0 && <p className="truncate text-xs text-fg-2">📎 {row.files.join(", ")}</p>}
            </li>
          ))}
        </ul>
      </div>
      {ui.status && (
        <p className="shrink-0 border-t border-line px-3 py-2 text-xs text-fg-2" role="status" data-testid="search-status">
          {statusText(ui.status, ui.scope, t)}
        </p>
      )}
    </div>
  );
}
