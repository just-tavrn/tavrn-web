// SPDX-License-Identifier: Apache-2.0
import { NavLink, Navigate, useNavigate, useParams } from "react-router";
import { Permission, hasPermission, parsePermissions } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { useRoom } from "../ChannelSidebar";
import { useNode } from "../../components/NodeScope";
import { OverviewTab } from "./OverviewTab";
import { RolesTab } from "./RolesTab";
import { ChannelsTab } from "./ChannelsTab";
import { BansTab, MembersTab } from "./MembersTab";
import { EmojisTab } from "./EmojisTab";
import { SoundboardTab } from "./SoundboardTab";
import { AuditTab, ModerationTab } from "./ModerationTab";
import { RoomProfileTab } from "./RoomProfileTab";
import { InvitesTab } from "./InvitesTab";
import { WebhooksTab } from "./WebhooksTab";
import { RoomApplicationsTab } from "./RoomApplicationsTab";

const TABS: readonly { id: string; needs: bigint; label?: string }[] = [
  { id: "overview", needs: 0n },
  { id: "profile", needs: 0n, label: "roomprofile.tab" },
  { id: "roles", needs: Permission.MANAGE_ROLES },
  { id: "channels", needs: Permission.MANAGE_CHANNELS },
  { id: "members", needs: 0n },
  { id: "bans", needs: Permission.BAN_MEMBERS },
  { id: "invites", needs: Permission.MANAGE_ROOM },
  { id: "webhooks", needs: Permission.MANAGE_WEBHOOKS },
  { id: "applications", needs: Permission.MANAGE_APPLICATIONS, label: "roomapps.tab" },
  { id: "emojis", needs: 0n },
  { id: "soundboard", needs: Permission.MANAGE_EMOJIS },
  { id: "moderation", needs: Permission.PURGE },
  { id: "audit", needs: Permission.VIEW_AUDIT_LOG },
];

export function RoomSettingsPage() {
  const t = useT();
  const { roomId = "", tab = "overview" } = useParams();
  const room = useRoom(roomId);
  const navigate = useNavigate();
  const { roomPath } = useNode();
  if (room.isPending) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  if (room.isError) return <p className="p-4 text-sm text-danger">{describeError(room.error)}</p>;
  const perms = parsePermissions(room.data.my_permissions);
  const visible = TABS.filter((x) => x.needs === 0n || hasPermission(perms, x.needs));
  if (!visible.some((x) => x.id === tab)) return <Navigate to={roomPath(roomId, undefined, "settings/overview")} replace />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={() => navigate(roomPath(roomId))} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("settings.back")}>
          ←
        </button>
        <h1 className="truncate text-sm font-semibold">{t("settings.title", { name: room.data.name })}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={t("settings.sections")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
          {visible.map((x) => (
            <NavLink key={x.id} to={roomPath(roomId, undefined, `settings/${x.id}`)} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
              {t(x.label ?? `settings.tab.${x.id}`)}
            </NavLink>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0}>
          {tab === "overview" && <OverviewTab key={room.data.id} room={room.data} />}
          {tab === "profile" && <RoomProfileTab room={room.data} />}
          {tab === "roles" && <RolesTab room={room.data} />}
          {tab === "channels" && <ChannelsTab room={room.data} />}
          {tab === "members" && <MembersTab room={room.data} />}
          {tab === "bans" && <BansTab room={room.data} />}
          {tab === "invites" && <InvitesTab room={room.data} />}
          {tab === "webhooks" && <WebhooksTab room={room.data} />}
          {tab === "applications" && <RoomApplicationsTab room={room.data} />}
          {tab === "emojis" && <EmojisTab room={room.data} />}
          {tab === "soundboard" && <SoundboardTab room={room.data} />}
          {tab === "moderation" && <ModerationTab room={room.data} />}
          {tab === "audit" && <AuditTab room={room.data} />}
        </div>
      </div>
    </div>
  );
}
