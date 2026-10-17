// SPDX-License-Identifier: Apache-2.0
/**
 * What the message body's pills and chips need from the open conversation: the room (roles, the channel being shown)
 * and its members (the role pill's member list), and the members' addresses (mentions a message does not list, such as
 * a bot card's roster, become pills: `lib/mentionBadges.ts` `MentionDirectory`). DMs pass their participants only.
 */
import { createContext, useContext } from "react";
import type { Member, RoomDetail } from "@tavrn/sdk";

export interface ChatLinksValue {
  room?: RoomDetail;
  roomMembers?: readonly Member[];
  /** Addresses of the conversation's members (room members or DM participants). */
  members?: readonly string[] | null;
}

const EMPTY: ChatLinksValue = {};

export const ChatLinksContext = createContext<ChatLinksValue>(EMPTY);

export function useChatLinks(): ChatLinksValue {
  return useContext(ChatLinksContext);
}
