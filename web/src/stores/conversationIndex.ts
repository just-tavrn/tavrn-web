// SPDX-License-Identifier: Apache-2.0
/**
 * The conversation index on the home node (FEDERATION.md §4), maintained by the client: an entry is
 * added after a join or a new DM, removed after leaving, and on start the index is reconciled with what
 * every node reports (its room and conversation lists). On a new device the index is what brings back
 * rooms on other nodes: it names the nodes to open federated sessions with.
 *
 * Writes replace the whole list with `If-Match`; on `412 index.version_conflict` the client reloads,
 * applies its pending changes to the fresh list and retries.
 */
import { create } from "zustand";
import { TavrnApiError, type ConversationIndexState, type IndexEntry, type TavrnApi } from "@tavrn/sdk";
import { api } from "../lib/api";
import { onAccountChange, useAuth } from "./auth";
import { apiFor, connectNode, homeDomain, isHome, useNodes } from "./nodes";
import { queryClient } from "../lib/queryClient";
import { conversationsQuery, roomsQuery } from "../lib/queries";

/** An entry; unknown fields written by other clients are kept. */
export type IndexItem = IndexEntry & Record<string, unknown>;

export type IndexOp =
  | { type: "add"; entry: IndexItem }
  | { type: "remove"; key: string }
  /** Reconciliation: for `node` and `kinds`, exactly `entries` (existing entries keep their fields). */
  | { type: "replace"; node: string; kinds: string[]; entries: IndexItem[] };

export const MAX_RETRIES = 3;

export function entryKey(e: Pick<IndexEntry, "node" | "kind" | "room_id" | "conversation_id">): string {
  return `${e.node}|${e.kind}|${e.room_id ?? e.conversation_id ?? ""}`;
}

export function roomEntry(node: string, roomId: string, joinedAt = new Date().toISOString()): IndexItem {
  return { node, kind: "room", room_id: roomId, conversation_id: null, joined_at: joinedAt };
}

export function conversationEntry(node: string, kind: "dm" | "group", conversationId: string, peer: string | null, joinedAt = new Date().toISOString()): IndexItem {
  return { node, kind, room_id: null, conversation_id: conversationId, ...(kind === "dm" && peer ? { peer } : {}), joined_at: joinedAt };
}

/** Applies `ops` to `items` (pure; used again on the fresh list after a version conflict). */
export function applyOps(items: IndexItem[], ops: IndexOp[]): IndexItem[] {
  let out = [...items];
  for (const op of ops) {
    if (op.type === "add") {
      const key = entryKey(op.entry);
      if (!out.some((e) => entryKey(e) === key)) out.push(op.entry);
    } else if (op.type === "remove") {
      out = out.filter((e) => entryKey(e) !== op.key);
    } else {
      const wanted = new Map(op.entries.map((e) => [entryKey(e), e]));
      const inScope = (e: IndexItem) => e.node === op.node && op.kinds.includes(e.kind);
      const kept = out.filter((e) => !inScope(e) || wanted.has(entryKey(e)));
      const have = new Set(kept.map(entryKey));
      out = [...kept, ...op.entries.filter((e) => !have.has(entryKey(e)))];
    }
  }
  return out;
}

const sameKeys = (a: IndexItem[], b: IndexItem[]) => a.length === b.length && a.every((e, i) => entryKey(e) === entryKey(b[i]!));

/**
 * Writes `ops` onto the index with optimistic concurrency: starts from `known` (or loads), retries
 * after a version conflict with the fresh list. Unchanged lists are not written.
 */
export async function writeIndex(client: Pick<TavrnApi, "conversationIndex">, ops: IndexOp[], known: ConversationIndexState | null): Promise<ConversationIndexState> {
  let current = known ?? (await client.conversationIndex.get());
  for (let attempt = 0; ; attempt++) {
    const items = applyOps(current.items as IndexItem[], ops);
    if (sameKeys(items, current.items as IndexItem[])) return current;
    try {
      return await client.conversationIndex.put(items, current.version);
    } catch (e) {
      if (!(e instanceof TavrnApiError) || e.code !== "index.version_conflict" || attempt >= MAX_RETRIES) throw e;
      current = await client.conversationIndex.get();
    }
  }
}

interface IndexStore {
  state: ConversationIndexState | null;
  load: () => Promise<ConversationIndexState>;
  /** Applies changes (serialized, best effort: the next reconciliation repairs a failed write). */
  change: (ops: IndexOp[]) => Promise<void>;
  reset: () => void;
}

let queue: Promise<unknown> = Promise.resolve();

export const useConversationIndex = create<IndexStore>((set, get) => ({
  state: null,
  load: async () => {
    const state = await api.conversationIndex.get();
    set({ state });
    return state;
  },
  change: (ops) => {
    const run = queue.then(async () => {
      const state = await writeIndex(api, ops, get().state);
      set({ state });
    });
    queue = run.catch(() => undefined);
    return run.catch(() => undefined);
  },
  reset: () => set({ state: null }),
}));

/** Records a join (room on any node) in the index. */
export function indexJoinedRoom(node: string | null | undefined, roomId: string): Promise<void> {
  const n = node ?? homeDomain();
  if (!n) return Promise.resolve();
  return useConversationIndex.getState().change([{ type: "add", entry: roomEntry(n, roomId) }]);
}

/** Records leaving a room in the index. */
export function indexLeftRoom(node: string | null | undefined, roomId: string): Promise<void> {
  const n = node ?? homeDomain();
  if (!n) return Promise.resolve();
  return useConversationIndex.getState().change([{ type: "remove", key: entryKey({ node: n, kind: "room", room_id: roomId, conversation_id: null }) }]);
}

/** Records a new DM or group DM (they live on the initiator's home node, §6). */
export function indexConversation(node: string | null | undefined, kind: string, conversationId: string, peer: string | null): Promise<void> {
  const n = node ?? homeDomain();
  if (!n || (kind !== "dm" && kind !== "group")) return Promise.resolve();
  return useConversationIndex.getState().change([{ type: "add", entry: conversationEntry(n, kind, conversationId, peer) }]);
}

/** Records leaving a DM or group DM in the index. */
export function indexLeftConversation(node: string | null | undefined, kind: string, conversationId: string): Promise<void> {
  const n = node ?? homeDomain();
  if (!n) return Promise.resolve();
  return useConversationIndex.getState().change([{ type: "remove", key: entryKey({ node: n, kind, room_id: null, conversation_id: conversationId }) }]);
}

/**
 * The DM with `peer` from the index, on whichever node it lives (FEDERATION.md §6.1: clients look for an
 * existing DM before creating one). With several (a race), the newest entry wins.
 */
export function findDm(peer: string, state: ConversationIndexState | null = useConversationIndex.getState().state): IndexItem | undefined {
  const dms = ((state?.items ?? []) as IndexItem[]).filter((e) => e.kind === "dm" && e.peer === peer && !!e.conversation_id);
  return dms.sort((a, b) => String(b.conversation_id).localeCompare(String(a.conversation_id)))[0];
}

/** Nodes other than the home node that the index or a session names. */
export function foreignNodes(state: ConversationIndexState | null): string[] {
  const home = homeDomain();
  const nodes = new Set<string>(Object.keys(useNodes.getState().sessions));
  for (const e of state?.items ?? []) nodes.add(e.node);
  if (home) nodes.delete(home);
  return [...nodes].sort();
}

/**
 * Reconciles the index with every node and re-establishes federated sessions for the nodes it names
 * (new device: this brings the rooms of other nodes back). Unreachable nodes keep their entries.
 */
export async function syncIndex(): Promise<void> {
  const home = homeDomain();
  if (!home) return;
  const store = useConversationIndex.getState();
  let state: ConversationIndexState;
  try {
    state = await store.load();
  } catch {
    return; // home node unreachable or no index support: try again on the next start
  }
  const existing = new Map((state.items as IndexItem[]).map((e) => [entryKey(e), e]));
  const keep = (e: IndexItem): IndexItem => existing.get(entryKey(e)) ?? e;
  const ops: IndexOp[] = [];
  const listNode = async (node: string, client: TavrnApi) => {
    // The shared queries: the room rail and the DM list fetch the same lists at start (one request each).
    const key = isHome(node) ? null : node;
    const [rooms, conversations] = await Promise.all([queryClient.fetchQuery(roomsQuery(key, client)), queryClient.fetchQuery(conversationsQuery(key, client))]);
    ops.push({ type: "replace", node, kinds: ["room"], entries: rooms.map((r) => keep(roomEntry(node, r.id))) });
    ops.push({
      type: "replace",
      node,
      kinds: ["dm", "group"],
      entries: conversations
        .filter((c) => c.kind === "dm" || c.kind === "group")
        .map((c) => keep(conversationEntry(node, c.kind as "dm" | "group", c.id, c.kind === "dm" ? (c.members.find((m) => m.address !== meAddress())?.address ?? null) : null))),
    });
  };
  await listNode(home, api).catch(() => undefined);
  await Promise.all(
    foreignNodes(state).map(async (node) => {
      try {
        await connectNode(node);
        await listNode(node, apiFor(node));
      } catch (e) {
        // A node that is down keeps its entries; one that refuses us for good is dropped from the index.
        if (e instanceof TavrnApiError && (e.code === "federation.peer_blocked" || e.code === "federation.user_banned")) {
          ops.push({ type: "replace", node, kinds: ["room", "dm", "group"], entries: [] });
        }
      }
    }),
  );
  if (ops.length) await store.change(ops);
}

function meAddress(): string | null {
  return useAuth.getState().user?.address ?? null;
}

// The index of an account that ended (sign-out, forced or in another tab, or another account) is forgotten: it decides
// which nodes need no confirmation (NodeScope), so the next account must never see it.
onAccountChange(() => useConversationIndex.getState().reset());
