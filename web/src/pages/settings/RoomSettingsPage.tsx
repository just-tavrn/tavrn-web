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
import { WhisperTab } from "./WhisperTab";
import { RoomProfileTab } from "./RoomProfileTab";
import { InvitesTab } from "./InvitesTab";
import { WebhooksTab } from "./WebhooksTab";
import { RoomApplicationsTab } from "./RoomApplicationsTab";
import { AutomodTab } from "../../moderation/AutomodTab";
import { ReportsInbox } from "../../moderation/ReportsInbox";
import { badgeText, useCapabilities, useOpenRoomReports } from "../../moderation/hooks";
import { HistoryRequestsTab } from "./HistoryRequestsTab";
import { RESTORE_CAPABILITY, useRestoreRequests } from "../../history/restore";
import { useRoomPreview } from "../../stores/rolePreview";
import { RoomLegalTab, showsLegalTab } from "./RoomLegalTab";

/** `anyOf`: one of these bits is enough; `cap`: only on nodes announcing the capability (MODERATION.md). */
const TABS: readonly { id: string; needs: bigint; label?: string; anyOf?: bigint[]; cap?: string }[] = [
  { id: "overview", needs: 0n },
  { id: "legal", needs: 0n },
  { id: "whisper", needs: 0n, label: "voice.whisper.title" },
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
  { id: "reports", needs: Permission.MODERATE_MEMBERS, label: "reports.tab", cap: "reports.v1" },
  { id: "automod", needs: 0n, anyOf: [Permission.MANAGE_ROOM, Permission.MODERATE_MEMBERS], label: "automod.tab", cap: "automod.v1" },
  { id: "history", needs: Permission.RESTORE_HISTORY, label: "history_restore.tab", cap: RESTORE_CAPABILITY },
  { id: "moderation", needs: Permission.PURGE },
  { id: "audit", needs: Permission.VIEW_AUDIT_LOG },
];

export function RoomSettingsPage() {
  const t = useT();
  const { roomId = "", tab = "overview" } = useParams();
  const room = useRoom(roomId);
  const navigate = useNavigate();
  const { roomPath, api, home, domain, me } = useNode();
  const caps = useCapabilities(home ? null : domain);
  const previewing = !!useRoomPreview(roomId);
  const moderates = hasPermission(parsePermissions(room.data?.my_permissions), Permission.MODERATE_MEMBERS);
  const openReports = badgeText(useOpenRoomReports(api, home ? null : domain, roomId, moderates && !!caps?.includes("reports.v1")));
  const restores = hasPermission(parsePermissions(room.data?.my_permissions), Permission.RESTORE_HISTORY);
  const openRestores = badgeText(useRestoreRequests(api, home ? null : domain, roomId, restores).data?.items.length);
  if (room.isPending) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  if (room.isError) return <p className="p-4 text-sm text-danger">{describeError(room.error)}</p>;
  const perms = parsePermissions(room.data.my_permissions);
  const visible = TABS.filter((x) => (x.needs === 0n || hasPermission(perms, x.needs)) && (!x.anyOf || x.anyOf.some((b) => hasPermission(perms, b))) && (!x.cap || !!caps?.includes(x.cap)) && (x.id !== "legal" || showsLegalTab(room.data)));
  // Tabs behind a capability wait for the node's answer instead of redirecting.
  if (!caps && TABS.some((x) => x.id === tab && x.cap)) return <p className="p-4 text-sm text-fg-2">{t("room.loading")}</p>;
  // A tab the previewed roles may not see (the preview was just started from the Roles tab): back to the room.
  if (!visible.some((x) => x.id === tab)) return <Navigate to={previewing ? roomPath(roomId) : roomPath(roomId, undefined, "settings/overview")} replace />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={() => navigate(roomPath(roomId))} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("settings.back")}>
          ←
        </button>
        <h1 className="truncate text-sm font-semibold">{t("settings.title", { name: room.data.name })}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={t("settings.sections")} className="flex shrink-0 select-none gap-1 overflow-x-auto border-b border-line p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
          {visible.map((x) => (
            <NavLink key={x.id} to={roomPath(roomId, undefined, `settings/${x.id}`)} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
              {t(x.label ?? `settings.tab.${x.id}`)}
              {x.id === "reports" && openReports && (
                <span className="ml-2 rounded-full bg-danger-solid px-1.5 text-[11px] font-semibold text-white" data-testid="reports-tab-badge">
                  {openReports}
                </span>
              )}
              {x.id === "history" && openRestores && (
                <span className="ml-2 rounded-full bg-danger-solid px-1.5 text-[11px] font-semibold text-white" data-testid="history-tab-badge">
                  {openRestores}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {/* `relative`: the scroll container is the containing block of positioned helpers inside a tab (`sr-only`
            legends); otherwise they are placed against the app shell, which grows and scrolls (tavrn-web#116). */}
        <div className="relative min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0}>
          {/* Role preview: the tabs and controls the roles would get; every change is refused (lib/previewGuard.ts). */}
          {previewing && (
            <p className="mb-4 rounded-md border border-accent/50 bg-accent-soft px-3 py-2 text-sm text-fg-0" data-testid="preview-settings-note">
              {t("roleview.settings_read_only")}
            </p>
          )}
          {tab === "overview" && <OverviewTab key={room.data.id} room={room.data} />}
          {tab === "legal" && <RoomLegalTab key={room.data.id} room={room.data} />}
          {tab === "whisper" && <WhisperTab key={room.data.id} roomId={room.data.id} />}
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
          {tab === "reports" && <ReportsInbox client={api} mode={{ kind: "room", roomId: room.data.id, node: home ? null : domain }} meId={me?.id} />}
          {tab === "automod" && <AutomodTab room={room.data} />}
          {tab === "history" && <HistoryRequestsTab room={room.data} />}
          {tab === "moderation" && <ModerationTab room={room.data} />}
          {tab === "audit" && <AuditTab room={room.data} />}
        </div>
      </div>
    </div>
  );
}
