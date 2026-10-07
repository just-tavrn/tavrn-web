// SPDX-License-Identifier: Apache-2.0
import { memo, useMemo } from "react";
import { isBotKind, type Member, type RoomDetail } from "@tavrn/sdk";
import { useLocale, useT } from "../i18n";
import { describeError } from "../stores/toasts";
import { MemberEntry } from "../components/MemberEntry";
import { BotBadge, KeyChangedBadge } from "../components/Badges";
import { VerifiedBadge, VerifyButton } from "../components/Verification";
import { MenuButton } from "../components/ContextMenu";
import { useMemberMenu } from "../components/menus/MemberMenu";
import { useRoomMembers } from "./ChannelPage";
import { useRoom } from "./ChannelSidebar";
import { SpeakerGlyph } from "../voice/ui/SpeakerGlyph";
import { groupMembers, memberColor, memberName } from "../lib/memberGroups";
import { usePresence } from "../stores/presence";
import { useAuth } from "../stores/auth";

/**
 * The member list of a room (design note 4.11): sections for hoisted roles ("display separately"), then
 * "Online" and "Offline"; every row has a context menu (right-click, long press, ⋯).
 */
export function MemberList({ roomId }: { roomId: string }) {
  const t = useT();
  const members = useRoomMembers(roomId);
  const room = useRoom(roomId);
  const locale = useLocale((s) => s.locale);
  const me = useAuth((s) => s.user?.address);
  const presence = usePresence((s) => s.users);
  const mine = usePresence((s) => s.mine);
  const sections = useMemo(() => {
    if (!members.data) return [];
    const online = (address: string) => {
      if (address === me) return (mine?.effective ?? "online") !== "invisible";
      const status = presence[address]?.status;
      return !!status && status !== "offline" && status !== "invisible";
    };
    return groupMembers(members.data, room.data?.roles ?? [], online, locale);
  }, [members.data, room.data?.roles, presence, mine?.effective, me, locale]);
  if (members.isPending) return <p className="text-sm text-fg-2">{t("members.loading")}</p>;
  if (members.isError) return <p className="text-sm text-danger">{describeError(members.error)}</p>;
  return (
    <div data-testid="member-list">
      <h2 className="sr-only">{t("members.count", { count: members.data.length })}</h2>
      {sections.map((section) => (
        <section key={section.id} className="mb-3" data-testid="member-section" data-section={section.kind === "role" ? section.role.name : section.kind}>
          <h3 className="flex items-center gap-1 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2">
            {section.kind === "role" ? section.role.name : t(`members.section.${section.kind}`)} – {section.members.length}
          </h3>
          <ul className="space-y-0.5">
            {section.members.map((m) => (
              <MemberRow key={m.user.id} roomId={roomId} room={room.data} member={m} offline={section.kind === "offline"} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const MemberRow = memo(function MemberRow({ roomId, room, member: m, offline }: { roomId: string; room: RoomDetail | undefined; member: Member; offline: boolean }) {
  const t = useT();
  const name = memberName(m);
  const color = room ? memberColor(m, room.roles) : null;
  return (
    <li className={`group flex min-h-10 items-center gap-1 rounded-md px-1 text-sm text-fg-1 hover:bg-bg-3/60 ${offline ? "opacity-70" : ""}`} title={m.user.address} data-testid="member-row" data-address={m.user.address}>
      {room ? <MemberWithMenu room={room} member={m} name={name} color={color} /> : <MemberEntry user={m.user} name={name} />}
      <SpeakerGlyph roomId={roomId} userId={m.user.id} address={m.user.address} />
      {isBotKind(m.user.kind) && <BotBadge />}
      <KeyChangedBadge address={m.user.address} />
      <VerifiedBadge address={m.user.address} />
      {m.timeout_until && Date.parse(m.timeout_until) > Date.now() && (
        <span role="img" title={t("member.timeout")} aria-label={t("member.timeout")} className="text-xs">
          ⏳
        </span>
      )}
      <VerifyButton address={m.user.address} name={name} className="ml-auto" />
    </li>
  );
});

function MemberWithMenu({ room, member, name, color }: { room: RoomDetail; member: Member; name: string; color: string | null }) {
  const t = useT();
  const { menu, overlay } = useMemberMenu(room, member);
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center" {...menu.triggerProps}>
        <MemberEntry user={member.user} name={name} color={color} />
      </div>
      <MenuButton menu={menu} label={t("menu.member.open", { name })} className="opacity-0 focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100" testId="member-menu-button" />
      {overlay}
    </>
  );
}
