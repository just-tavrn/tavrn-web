// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import type { User } from "@tavrn/sdk";
import { MediaAvatar, useAvatarUrls } from "../../components/Avatar";
import { useRoomMembers } from "../../pages/ChannelPage";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The avatar of a voice participant (channel list rows, stage tiles, join panel, calls), with the member's
 * avatar image from the room's member list (or `user` directly, e.g. a call's conversation members,
 * design note 4.9). Animated avatars play only while the participant is `speaking` (design note 4.5 item 6). On
 * the stage (`stage`) that is the only time: the tile shows the still frame otherwise, also on hover. In
 * lists the animation also plays on hover. Speaking rings are drawn by the callers (`voice-ring`,
 * `voice-tile`).
 */
export function AvatarTile(props: { roomId?: string; user?: User | null; name: string; address: string; size: number; speaking?: boolean; stage?: boolean }) {
  const members = useRoomMembers(props.roomId ?? "");
  const user = useMemo(() => (props.user !== undefined ? props.user : (members.data?.find((m) => m.user.address === props.address)?.user ?? null)), [members.data, props.address, props.user]);
  const { still, animated } = useAvatarUrls(user);
  const playing = !!animated && !!props.speaking && !reducedMotion();
  return (
    <span className="voice-avatar inline-flex rounded-full" data-animate={playing || undefined} data-has-animation={animated ? "true" : undefined}>
      <MediaAvatar name={props.name} still={playing ? animated : still} animated={playing || props.stage ? null : animated} size={props.size} />
    </span>
  );
}
