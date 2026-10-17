// SPDX-License-Identifier: Apache-2.0
/**
 * Invitations of the invite list on the home node (FEDERATION.md §3.4, §4, §6.1). Accepting joins on the
 * node that hosts the room or conversation (with a federated session there), records the index entry
 * and dismisses the invitation. DMs and group DMs started by a friend are accepted without asking, like a
 * DM of a friend on the same node simply appears in the list.
 */
import type { InvitePreview, PendingInvite, RoomPreview } from "@tavrn/sdk";
import { api } from "./api";
import { useAuth } from "../stores/auth";
import { apiFor, connectNode, isHome } from "../stores/nodes";
import { indexConversation, indexJoinedRoom } from "../stores/conversationIndex";
import { conversationPath, roomPath } from "../components/NodeScope";

/**
 * Conversation invitations of friends are accepted automatically; rooms and everything else ask. Only
 * when the friend is a user of the hosting node: conversations live on the initiator's home node (§6.1),
 * and a node may name an inviter of another domain (a remote member adding someone to a group), so a
 * node could otherwise borrow the name of a friend elsewhere to pull the client to it.
 */
export function autoAccepts(invite: PendingInvite, friends: Iterable<string>): boolean {
  const inviterDomain = invite.inviter.slice(invite.inviter.lastIndexOf("@") + 1);
  return invite.kind === "conversation" && !!invite.conversation?.id && inviterDomain === invite.node && new Set(friends).has(invite.inviter);
}

/**
 * The preview of a room invitation on the hosting node (rules, privacy notice, legal notice; PROTOCOL.md §6b), shown
 * before the join (components/JoinRoomDialog.tsx): the invite preview of the invitation's code, the room preview
 * without one.
 */
export async function invitePreview(invite: PendingInvite): Promise<InvitePreview | RoomPreview> {
  if (!isHome(invite.node)) await connectNode(invite.node);
  const client = apiFor(invite.node);
  return invite.invite_code ? client.invites.preview(invite.invite_code) : client.rooms.preview(invite.room?.id ?? "");
}

/**
 * Joins the room or conversation of `invite` on its node and returns the route to open. Rooms join with
 * the invitation's (address-bound) code and `acceptRules`, the user's answer to the rules the join dialog showed
 * (tavrn-web#195; never assumed); conversations are only checked: the hosting node already lists
 * the user as a member, and the node's answer (not the invitation) decides the index entry.
 */
export async function acceptInvite(invite: PendingInvite, acceptRules = false): Promise<string> {
  const home = isHome(invite.node);
  if (!home) await connectNode(invite.node);
  const client = apiFor(invite.node);
  let path: string;
  if (invite.kind === "room") {
    const req = { accept_rules: acceptRules };
    const room = invite.invite_code ? await client.invites.join(invite.invite_code, req) : await client.rooms.join(invite.room?.id ?? "", req);
    await indexJoinedRoom(invite.node, room.id);
    path = roomPath(home ? null : invite.node, room.id);
  } else {
    const c = await client.conversations.get(invite.conversation?.id ?? "");
    const me = useAuth.getState().user?.address;
    const kind = c.kind === "dm" ? "dm" : "group";
    await indexConversation(invite.node, kind, c.id, kind === "dm" ? (c.members.find((m) => m.address !== me)?.address ?? null) : null);
    path = conversationPath(invite.node, c.id);
  }
  await api.users.dismissInvite(invite.id).catch(() => undefined);
  return path;
}

/**
 * At start: conversation invitations of friends that arrived while this client was offline are accepted
 * like the live ones. Returns the hosting nodes of the accepted conversations (their Welcomes wait there).
 */
export async function acceptFriendInvites(): Promise<string[]> {
  const [invites, friends] = await Promise.all([api.users.invites().catch(() => null), api.friends.list().catch(() => null)]);
  if (!invites || !friends) return [];
  const addresses = friends.friends.map((f) => f.user.address);
  const nodes: string[] = [];
  for (const invite of invites.items.filter((i) => autoAccepts(i, addresses))) {
    try {
      await acceptInvite(invite);
      nodes.push(invite.node);
    } catch {
      /* stays in the invite list (node down, conversation gone) */
    }
  }
  return nodes;
}
