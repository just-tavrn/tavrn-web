// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import type { RoomDetail, VoiceParticipant } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { useMemberMenu } from "../../components/menus/MemberMenu";
import { useRoomMembers } from "../../pages/ChannelPage";

/**
 * The context menu of a voice participant (list row or stage tile, design note 4.13 item 3): the member list's
 * dropdown (right-click at the pointer, long press, ⋯) for the participant's member entry, loading the
 * member list when needed. Participants whose entry is not loaded and members of other nodes get the
 * reduced voice menu (volume, server mute, disconnect, move, copy).
 */
export function useParticipantMenu(room: RoomDetail, channelId: string, participant: VoiceParticipant | null) {
  const { domain } = useNode();
  const members = useRoomMembers(room.id);
  const member = useMemo(() => {
    if (!participant) return null;
    const found = members.data?.find((m) => m.user.id === participant.user_id) ?? members.data?.find((m) => m.user.address === participant.user);
    return found && found.user.domain === domain ? found : null;
  }, [members.data, participant, domain]);
  return useMemberMenu(room, member, participant ? { participant, channelId } : undefined);
}
