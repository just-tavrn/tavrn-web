// SPDX-License-Identifier: Apache-2.0
import { useT } from "../../i18n";
import { useNode } from "../../components/NodeScope";
import { useVoicePresence, voiceChannelOfUser } from "../presence";
import { useAddressSpeaking } from "./common";
import { SpeakerIcon } from "./icons";

/**
 * Member list (design note 4.5 item 6): a small speaker glyph next to members who are in a voice channel of
 * the room, lit while they speak (visible to participants of the same call).
 */
export function SpeakerGlyph({ roomId, userId, address }: { roomId: string; userId: string; address: string }) {
  const t = useT();
  const { domain } = useNode();
  const inVoice = useVoicePresence((s) => voiceChannelOfUser(s, domain, roomId, userId) !== null);
  const speaking = useAddressSpeaking(address);
  if (!inVoice) return null;
  return (
    <span role="img" className={`voice-glyph shrink-0 ${speaking ? "text-accent" : "text-fg-2"}`} data-speaking={speaking || undefined} title={t("voice.in_voice")} aria-label={t("voice.in_voice")} data-testid="member-voice">
      <SpeakerIcon size={13} />
    </span>
  );
}
