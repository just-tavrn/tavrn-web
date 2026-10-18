// SPDX-License-Identifier: Apache-2.0
import { useNode } from "../../components/NodeScope";
import { useRoomMembers } from "../ChannelPage";
import { WhisperSection } from "./WhisperSection";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";

export function WhisperTab({ roomId }: { roomId: string }) {
  const { domain, me } = useNode();
  const members = useRoomMembers(roomId);
  const t = useT();
  if (members.isPending) return <p>{t("common.loading")}</p>;
  if (members.isError) return <p role="alert">{describeError(members.error)}</p>;
  return <WhisperSection key={`${domain}/${roomId}`} domain={domain} roomId={roomId} members={members.data} self={me?.address} />;
}
