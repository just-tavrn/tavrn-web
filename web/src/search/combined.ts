// SPDX-License-Identifier: Apache-2.0
/**
 * One search over both paths (design note 4.4 "Search", tavrn-protocol/SEARCH.md §4): the node's full-text search
 * for unencrypted channels (`GET /rooms/{id}/search`, per room, at most {@link MAX_ROOMS} rooms for
 * "everywhere") and the local encrypted index for encrypted channels and DMs. Results are merged newest
 * first; the status says honestly what was searched.
 */
import { qualify, DEFAULT_WINDOW_DAYS, type Coverage, type LocalHit, type SearchIndex } from "@tavrn/e2ee";
import { TavrnApiError, type SearchQuery, type SearchResponse, type TavrnApi } from "@tavrn/sdk";

/** Rooms searched on the nodes for "everywhere" (one request each). */
export const MAX_ROOMS = 20;
/** Node requests in flight at once. */
const PARALLEL = 4;
const DAY_MS = 86_400_000;

export type Scope = "room" | "conversation" | "everywhere";

export interface Filters {
  /** Room scope: one channel id. */
  channel?: string;
  /** Author address. */
  author?: string;
  /** `YYYY-MM-DD` (UTC), inclusive. */
  from?: string;
  /** `YYYY-MM-DD` (UTC), inclusive. */
  to?: string;
  hasFile?: boolean;
}

export interface SearchRow {
  key: string;
  source: "node" | "local";
  /** Domain of the node hosting the conversation. */
  node: string;
  roomId?: string;
  conversationId: string;
  messageId: string;
  author: string;
  /** ms */
  ts: number;
  snippet: string;
  files: string[];
}

export interface SearchStatus {
  /** Unencrypted channels the nodes searched. */
  nodeChannels: number;
  /** Rooms searched on nodes, rooms left out (cap), rooms whose node failed or has no search. */
  nodeRooms: number;
  roomsSkipped: number;
  nodeFailed: number;
  /** Encrypted conversations in scope the local index covers (window or complete), complete ones, not synced yet. */
  localSearched: number;
  localComplete: number;
  localNotSynced: number;
  windowDays: number;
  /** The local index is not available (locked store, no encryption on this device). */
  localLocked: boolean;
}

/** A room the node search covers. */
export interface RoomRef {
  node: string;
  roomId: string;
  api: Pick<TavrnApi, "search">;
}

/** A conversation whose encrypted messages the local index covers. */
export interface LocalRef {
  node: string;
  conversationId: string;
  roomId?: string;
}

export interface SearchRequest {
  query: string;
  filters: Filters;
  rooms: RoomRef[];
  /** Encrypted conversations in scope; `null` = everything the local index holds ("everywhere"). */
  local: LocalRef[] | null;
  /** Rooms the user is in but beyond the cap (for the status line). */
  roomsSkipped?: number;
}

/** The node's query parameters for the filters. */
export function nodeQuery(query: string, f: Filters): SearchQuery {
  const q: SearchQuery = { limit: 50 };
  if (query.trim()) q.q = query.trim().slice(0, 256);
  if (f.channel) q.channel = f.channel;
  if (f.author?.trim()) q.author = f.author.trim();
  if (f.from) q.after = f.from;
  if (f.to) q.before = dayAfter(f.to);
  if (f.hasFile) q.has = "file";
  return q;
}

function dayAfter(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t + DAY_MS).toISOString().slice(0, 10) : day;
}

/** Is there anything to search for (words or a filter)? */
export function searchable(query: string, f: Filters): boolean {
  return /[\p{L}\p{N}]/u.test(query) || !!f.author?.trim() || !!f.from || !!f.to || !!f.hasFile;
}

export function nodeRows(node: string, roomId: string, resp: SearchResponse): SearchRow[] {
  return resp.results.map((r) => ({
    key: `n:${node}/${r.message.id}`,
    source: "node" as const,
    node,
    roomId,
    conversationId: r.message.conversation_id,
    messageId: r.message.id,
    author: r.message.author,
    ts: Date.parse(r.message.created_at),
    snippet: r.snippet,
    files: (r.message.attachments ?? []).map((a) => a.name),
  }));
}

export function localRows(hits: LocalHit[]): SearchRow[] {
  return hits.map((h) => {
    const slash = h.conversation.indexOf("/");
    return {
      key: `l:${h.conversation}/${h.id}`,
      source: "local" as const,
      node: h.conversation.slice(0, slash),
      ...(h.room ? { roomId: h.room } : {}),
      conversationId: h.conversation.slice(slash + 1),
      messageId: h.id,
      author: h.author,
      ts: h.ts,
      snippet: h.snippet,
      files: h.files,
    };
  });
}

/** Newest first, one row per message (a message found by both paths, e.g. after an encryption switch, once). */
export function mergeRows(lists: SearchRow[][]): SearchRow[] {
  const seen = new Set<string>();
  const out: SearchRow[] = [];
  for (const row of lists.flat().sort((a, b) => b.ts - a.ts || (a.messageId < b.messageId ? 1 : -1))) {
    const id = `${row.node}/${row.messageId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/** Local coverage of the conversations in scope: searched (window synced or complete), complete, not synced yet. */
export function localStatus(scope: LocalRef[] | null, coverage: Record<string, Coverage>): Pick<SearchStatus, "localSearched" | "localComplete" | "localNotSynced"> {
  const qs = scope ? scope.map((r) => qualify(r.node, r.conversationId)) : Object.keys(coverage);
  let searched = 0;
  let complete = 0;
  let notSynced = 0;
  for (const q of qs) {
    const c = coverage[q];
    const synced = !!c && (c.sync.done || (c.complete && c.sync.reachedStart));
    if (synced) searched++;
    else notSynced++;
    if (c?.complete) complete++;
  }
  return { localSearched: searched, localComplete: complete, localNotSynced: notSynced };
}

async function inBatches<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.allSettled(items.slice(i, i + n).map(fn))));
  return out;
}

/** Runs both paths. `index` is null while the local index is locked or unavailable. */
export async function runSearch(req: SearchRequest, index: SearchIndex | null, coverage: Record<string, Coverage>): Promise<{ rows: SearchRow[]; status: SearchStatus }> {
  const { query, filters } = req;
  const nq = nodeQuery(query, filters);
  const settled = await inBatches(req.rooms, PARALLEL, async (r) => ({ room: r, resp: await r.api.search.room(r.roomId, nq) }));
  const lists: SearchRow[][] = [];
  let nodeChannels = 0;
  let nodeFailed = 0;
  for (const s of settled) {
    if (s.status === "fulfilled") {
      nodeChannels += s.value.resp.searched.channels;
      lists.push(nodeRows(s.value.room.node, s.value.room.roomId, s.value.resp));
    } else if (!(s.reason instanceof TavrnApiError && s.reason.code === "search.query_empty")) {
      nodeFailed++;
    }
  }
  const after = filters.from ? Date.parse(`${filters.from}T00:00:00Z`) - 1 : undefined;
  const before = filters.to ? Date.parse(`${filters.to}T00:00:00Z`) + DAY_MS : undefined;
  if (index && (req.local === null || req.local.length > 0)) {
    const conversations = req.local?.map((r) => qualify(r.node, r.conversationId));
    const channelFilter = filters.channel ? req.local?.filter((r) => r.conversationId === filters.channel).map((r) => qualify(r.node, r.conversationId)) : undefined;
    try {
      const hits = await index.search(query, {
        ...(channelFilter ? { conversations: channelFilter } : conversations ? { conversations } : {}),
        ...(filters.author?.trim() ? { author: filters.author.trim().toLowerCase() } : {}),
        ...(after !== undefined && Number.isFinite(after) ? { after } : {}),
        ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
        ...(filters.hasFile ? { hasFile: true } : {}),
        limit: 50,
      });
      // Local hits of conversations of the request carry the room (channels opened before the room was noted).
      const rooms = new Map((req.local ?? []).filter((r) => r.roomId).map((r) => [qualify(r.node, r.conversationId), r.roomId!]));
      lists.push(localRows(hits.map((h) => (h.room || !rooms.has(h.conversation) ? h : { ...h, room: rooms.get(h.conversation)! }))));
    } catch {
      /* locked meanwhile: the status says so */
    }
  }
  const local = localStatus(req.local, coverage);
  return {
    rows: mergeRows(lists),
    status: {
      nodeChannels,
      nodeRooms: req.rooms.length - nodeFailed,
      roomsSkipped: req.roomsSkipped ?? 0,
      nodeFailed,
      ...local,
      windowDays: DEFAULT_WINDOW_DAYS,
      localLocked: !index,
    },
  };
}

/** Splits a snippet at the highlight markers: odd parts are matches. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const out: { text: string; match: boolean }[] = [];
  let match = false;
  let buf = "";
  for (const ch of snippet) {
    if (ch === "\u0001" || ch === "\u0002") {
      if (buf) out.push({ text: buf, match });
      buf = "";
      match = ch === "\u0001";
      continue;
    }
    buf += ch;
  }
  if (buf) out.push({ text: buf, match });
  return out;
}
