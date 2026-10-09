// SPDX-License-Identifier: Apache-2.0
/**
 * Discover (FEDERATION.md §7.5): the directory of the node this client was loaded from, with the
 * listing of every room verified against its hosting node's own keys, and joining a room on any node.
 *
 * - Rooms whose listing does not verify (wrong signer, other room, expired, tampered) are dropped; the
 *   values shown are the signed ones.
 * - Keys come from the hosting node's discovery document: the client's own node on this origin, any
 *   other node straight from its domain or through this node's peer proxy (§1.4). Cached for an hour.
 * - Joining a room of another node opens a federated session there first (§3.1), then the room lands
 *   in the conversation index like every other join.
 */
import { discoverNode, verifyDirectoryRooms, type DirectoryNodeList, type DirectoryRoom, type PublicKeyInfo, type TavrnApi, type VerifiedRoom, type WellKnown } from "@tavrn/sdk";
import { api, publicApi } from "../lib/api";
import { useAuth } from "./auth";
import { roomPath } from "../components/NodeScope";
import { indexJoinedRoom } from "./conversationIndex";
import { DISCOVERY_TTL_MS, apiFor, connectNode, isHome, useNodes } from "./nodes";

export interface RoomFilter {
  q?: string;
  minMembers?: number;
  /** Only rooms of this node. */
  node?: string;
  cursor?: string;
}

export interface RoomPage {
  rooms: VerifiedRoom[];
  next: string | null;
  /** Entries dropped because their listing did not verify. */
  hidden: number;
}

/** Replaceable pieces (tests). */
export const discoverDeps = {
  now: () => Date.now(),
  /**
   * The directory of the node this client was loaded from: with the session of an account of that node, so it lists
   * rooms with an age gate to adults (PROTOCOL.md §5e); anonymously otherwise.
   */
  directory: () => (useAuth.getState().token && !useAuth.getState().home ? api.directory : publicApi.directory),
  /** Discovery document of `domain` (the client's own node on this origin). */
  document: async (domain: string): Promise<WellKnown> => {
    const own = await originDocument();
    if (own.domain === domain) return own;
    return discoverNode(domain, { proxy: (d) => publicApi.federation.peer(d) });
  },
};

let origin: Promise<WellKnown> | null = null;

function originDocument(): Promise<WellKnown> {
  origin ??= publicApi.node.wellKnown().catch((e: unknown) => {
    origin = null;
    throw e;
  });
  return origin;
}

const keyCache = new Map<string, { at: number; keys: PublicKeyInfo[] }>();

/** Signing keys of `domain` from its own discovery document (cached for an hour). */
export async function keysOf(domain: string): Promise<PublicKeyInfo[]> {
  const hit = keyCache.get(domain);
  if (hit && discoverDeps.now() - hit.at < DISCOVERY_TTL_MS) return hit.keys;
  const doc = await discoverDeps.document(domain);
  // A document only speaks for its own domain.
  if (doc.domain !== domain || !Array.isArray(doc.keys)) throw new Error(`no valid discovery document for ${domain}`);
  keyCache.set(domain, { at: discoverDeps.now(), keys: doc.keys });
  return doc.keys;
}

/** Forget cached keys and the origin document (tests, sign-out). */
export function resetDiscoverCaches(): void {
  keyCache.clear();
  origin = null;
}

/** One page of discoverable rooms, verified. */
export async function loadRooms(filter: RoomFilter = {}): Promise<RoomPage> {
  const q = filter.q?.trim();
  const page = await discoverDeps.directory().rooms({ q: q || undefined, node: filter.node, min_members: filter.minMembers || undefined, cursor: filter.cursor, limit: 50 });
  const rooms = await verifyDirectoryRooms(page.items as DirectoryRoom[], keysOf);
  return { rooms, next: page.next ?? null, hidden: page.items.length - rooms.length };
}

/** One page of listed nodes. */
export async function loadNodes(filter: { q?: string; cursor?: string } = {}): Promise<DirectoryNodeList> {
  const q = filter.q?.trim();
  return discoverDeps.directory().nodes({ q: q || undefined, cursor: filter.cursor });
}

/**
 * Joins a room from the directory: on the home node directly, on any other node through a federated
 * session. Returns the route of the joined room.
 */
export async function joinRoom(room: Pick<DirectoryRoom, "node" | "room_id">): Promise<string> {
  const home = isHome(room.node);
  if (!home) await connectNode(room.node);
  const node = home ? null : room.node;
  const joined = await apiFor(node).rooms.join(room.room_id, { accept_rules: true });
  await indexJoinedRoom(node, joined.id);
  return roomPath(node, joined.id);
}

/** Absolute URLs of a room icon: the still, and the animated variant if there is one (design note 4.9). */
export interface RoomIconUrls {
  still: string;
  animated: string | null;
}

/**
 * The client that may load the room icons of `node` for Discover, or null. Directory entries carry no
 * icons (FEDERATION.md §7.4: clients never load images of other nodes), so icons come only from nodes
 * this client already talks to: the node it was loaded from (`origin`), the home node and nodes with a
 * federated session. Rooms of every other node keep their initials.
 */
export function iconClient(node: string, origin: string | null): TavrnApi | null {
  if (isHome(node) || useNodes.getState().sessions[node]) return apiFor(node);
  if (origin && node === origin) return publicApi;
  return null;
}

/** Icons of the public rooms of the node behind `client` (`GET /rooms/discover`), by room id. */
export async function loadRoomIcons(client: TavrnApi): Promise<Record<string, RoomIconUrls>> {
  const out: Record<string, RoomIconUrls> = {};
  for (const r of await client.rooms.discover()) {
    const still = client.mediaUrl(r.icon_still);
    if (!still) continue;
    const full = client.mediaUrl(r.icon);
    out[r.id] = { still, animated: full && full !== still ? full : null };
  }
  return out;
}
