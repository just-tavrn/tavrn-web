// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RoomIcon } from "../components/Avatar";
import { NavLink } from "react-router";
import { Permission, hasPermission, parsePermissions, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { useNodes } from "../stores/nodes";
import { homeWeb } from "../stores/auth";
import { useShell } from "../components/AppShell";
import { categoryName, channelName } from "../lib/names";
import { Button, Dialog, ErrorText, Field, Input } from "../components/ui";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { useUnread } from "../stores/unread";
import { syncInboxChannels } from "../stores/mls";
import { BotsAllowedIcon, NoBotsIcon, UnreadBadges, useHasUnread } from "../components/Badges";
import { botMarker } from "../lib/botAccess";
import { VoiceChannelRow } from "../voice/ui/VoiceChannelRow";
import { MenuButton } from "../components/ContextMenu";
import { useChannelMenu } from "../components/menus/ChannelMenu";
import { mutedNow, useNotifications } from "../stores/notifications";
import { DEFAULT_EXPIRY_HOURS, expiryChoices } from "../lib/inviteExpiry";
import { useRoomMenu } from "../components/menus/RoomMenu";
import { ChevronDownIcon } from "../components/icons";
import { badgeText, useCapabilities, useOpenRoomReports } from "../moderation/hooks";

/** Room detail; its `read_states` seed the unread counts of the channels (design note 4.4). */
export function useRoom(roomId: string) {
  const { api, domain } = useNode();
  return useQuery({
    queryKey: ["room", roomId],
    queryFn: async () => {
      const room = await api.rooms.get(roomId);
      useUnread.getState().seed(room.read_states ?? []);
      void syncInboxChannels(domain, room.channels);
      return room;
    },
  });
}

/**
 * "New" for the welcome channel (design note 4.11): something arrived after the user's read marker, i.e.
 * since they last opened it. No counts, no mention badges.
 */
function useSystemNew(channelId: string): boolean {
  return useUnread((s) => {
    const info = s.states[channelId];
    return !!info?.last && (!info.read || info.last > info.read);
  });
}

function ChannelLink({ room, channel, onClick }: { room: RoomDetail; channel: Channel; onClick: () => void }) {
  const t = useT();
  const system = channel.kind === "system";
  const unreadCount = useHasUnread(channel.id);
  const systemNew = useSystemNew(channel.id);
  const unread = system ? systemNew : unreadCount;
  const { roomPath } = useNode();
  // Context menu (design note 4.11): right-click, long press, keyboard or the ⋯ button.
  const { menu, overlay } = useChannelMenu(room, channel);
  return (
    <div className="group relative flex items-center" data-testid="channel-row" data-channel={channel.id} data-kind={channel.kind}>
      <NavLink
        to={roomPath(room.id, channel.id)}
        onClick={onClick}
        data-unread={unread || undefined}
        {...menu.triggerProps}
        className={({ isActive }) => `flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : unread ? "text-fg-0 hover:bg-bg-3/60" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}
      >
        <ChannelIcon kind={channel.kind} encrypted={channel.encrypted} />
        <span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>{channelName(channel)}</span>
        {system ? systemNew && <span role="img" className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label={t("members.welcome_new")} data-testid="welcome-new" /> : <UnreadBadges conversationId={channel.id} />}
        <MutedMark conversationId={channel.id} roomId={room.id} />
        {botMarker(channel, room) === "no_bots" && <NoBotsIcon />}
        {botMarker(channel, room) === "bots_allowed" && <BotsAllowedIcon />}
      </NavLink>
      <MenuButton menu={menu} label={t("menu.channel.open", { name: channelName(channel) })} className="pointer-events-none absolute right-1 bg-bg-1 opacity-0 focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 pointer-coarse:hidden" testId="channel-menu-button" />
      {overlay}
    </div>
  );
}

/** A small bell-off glyph on muted channels (design note 4.11). */
function MutedMark({ conversationId, roomId }: { conversationId: string; roomId: string }) {
  const t = useT();
  const muted = useNotifications((s) => mutedNow(s.settings.channels[conversationId]?.muted_until) || mutedNow(s.settings.rooms[roomId]?.muted_until));
  if (!muted) return null;
  return (
    <span role="img" className="shrink-0 text-[11px] text-fg-2" title={t("notify.muted")} aria-label={t("notify.muted")} data-testid="channel-muted">
      🔕
    </span>
  );
}

/** Voice rows bring the channel menu themselves (right-click, long press, ⋯); participant rows keep their own. */
const VoiceRowWithMenu = VoiceChannelRow;

function ChannelIcon({ kind, encrypted }: { kind: string; encrypted: boolean }) {
  const t = useT();
  const icon = kind === "voice" ? "🔊" : kind === "announcement" ? "📣" : kind === "forum" ? "🗂" : kind === "files" ? "📁" : kind === "system" ? "👋" : "#";
  return (
    <span className="flex w-5 shrink-0 items-center justify-center gap-0.5 text-fg-2">
      <span aria-hidden="true">{icon}</span>
      {kind !== "voice" && kind !== "system" &&
        (encrypted ? (
          <span role="img" aria-label={t("channel.encrypted")} title={t("channel.encrypted")} className="text-[10px]" data-testid="channel-lock">
            🔒
          </span>
        ) : (
          <span role="img" aria-label={t("channel.unencrypted")} title={t("channel.unencrypted")} className="text-[10px]" data-testid="channel-unlocked">
            🔓
          </span>
        ))}
    </span>
  );
}

export function ChannelSidebar({ roomId }: { roomId: string }) {
  const t = useT();
  const room = useRoom(roomId);
  const { closeNav } = useShell();
  const node = useNode();
  const [createOpen, setCreateOpen] = useState(false);
  // The room header opens the room's menu (invite, settings, notifications, …); moderators see the open reports on it.
  const nodeKey = node.home ? null : node.domain;
  const moderates = hasPermission(parsePermissions(room.data?.my_permissions), Permission.MODERATE_MEMBERS);
  const reportsOffered = !!useCapabilities(nodeKey)?.includes("reports.v1");
  const openReports = badgeText(useOpenRoomReports(node.api, nodeKey, roomId, moderates && reportsOffered));
  const headerMenu = useRoomMenu({ id: roomId, name: room.data?.name ?? "" }, nodeKey, { openReports });
  if (room.isPending) return <p className="p-3 text-sm text-fg-2">{t("room.loading")}</p>;
  if (room.isError) return <p className="p-3 text-sm text-danger">{describeError(room.error)}</p>;
  const r = room.data;
  const perms = parsePermissions(r.my_permissions);
  const canManageChannels = hasPermission(perms, Permission.MANAGE_CHANNELS);

  // The welcome channel (kind `system`, design note 4.11) is pinned at the very top, outside the categories.
  const pinned = r.channels.filter((c) => c.kind === "system");
  const byCategory = new Map<string | null, Channel[]>();
  for (const c of r.channels) {
    if (c.kind === "system") continue;
    const key = c.category_id ?? null;
    byCategory.set(key, [...(byCategory.get(key) ?? []), c]);
  }
  const groups: { id: string | null; name: string | null; channels: Channel[] }[] = [
    ...(byCategory.get(null)?.length ? [{ id: null, name: null, channels: byCategory.get(null)! }] : []),
    ...r.categories.map((cat) => ({ id: cat.id, name: categoryName(cat), channels: byCategory.get(cat.id) ?? [] })),
  ];

  return (
    <div className="flex flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-line px-2" data-testid="room-header">
        {/* One menu button: icon, name (with the node of a remote room below it) and the chevron with the reports badge. */}
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={headerMenu.menu.open}
            aria-label={[r.name, !node.home && node.domain, openReports && t(openReports === "1" ? "reports.open_reports_one" : "reports.open_reports_many", { count: openReports })].filter(Boolean).join(", ")}
            title={t("menu.label", { name: r.name })}
            data-testid="room-header-menu"
            className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-bg-3"
            onClick={(e) => {
              if (headerMenu.menu.open) headerMenu.menu.close();
              else headerMenu.menu.openAt(e.currentTarget);
            }}
            onContextMenu={headerMenu.menu.triggerProps.onContextMenu}
          >
            <RoomIcon room={r} size={28} testId="room-header-icon" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-fg-0" data-testid="room-name">
                {r.name}
              </span>
              {/* Rooms of other nodes always show their node (design note 9d). */}
              {!node.home && (
                <span className="block truncate text-[11px] font-normal text-fg-2" data-testid="room-node" title={t("node.room_on", { domain: node.domain })}>
                  {node.domain}
                </span>
              )}
            </span>
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center text-fg-2" aria-hidden="true">
              <ChevronDownIcon size={18} />
              {openReports && (
                <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-danger-solid px-1 text-center text-[10px] font-semibold leading-4 text-white" data-testid="room-reports-badge">
                  {openReports}
                </span>
              )}
            </span>
          </button>
        </h2>
        {headerMenu.overlay}
      </div>
      <nav aria-label={t("shell.channels")} className="p-2">
        {pinned.length > 0 && (
          <ul className="mb-2" data-testid="pinned-channels">
            {pinned.map((c) => (
              <li key={c.id}>
                <ChannelLink room={r} channel={c} onClick={closeNav} />
              </li>
            ))}
          </ul>
        )}
        {groups.map((g) => (
          <div key={g.id ?? "none"} className="mb-2">
            {g.name && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-2">{g.name}</div>}
            <ul>
              {g.channels.map((c) => (
                <li key={c.id}>
                  {c.kind === "voice" ? <VoiceRowWithMenu room={r} channel={c} onNavigate={closeNav} /> : <ChannelLink room={r} channel={c} onClick={closeNav} />}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {canManageChannels && (
          <button type="button" onClick={() => setCreateOpen(true)} className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-2 hover:bg-bg-3/60 hover:text-fg-0">
            <span className="w-5 text-center">+</span> {t("channel.create")}
          </button>
        )}
      </nav>
      <CreateChannelDialog roomId={roomId} open={createOpen} onClose={() => setCreateOpen(false)} categories={r.categories} />
    </div>
  );
}

function CreateChannelDialog({ roomId, open, onClose, categories }: { roomId: string; open: boolean; onClose: () => void; categories: { id: string; name: string }[] }) {
  const t = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("text");
  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { api } = useNode();
  return (
    <Dialog title={t("channel.create.title")} open={open} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.channels.create(roomId, { kind, name, category_id: categoryId || null });
            await queryClient.invalidateQueries({ queryKey: ["room", roomId] });
            setName("");
            onClose();
          } catch (err) {
            setError(describeError(err));
          }
        }}
      >
        <Field label={t("channel.kind")}>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="min-h-10 w-full rounded-md border border-line bg-bg-0 px-3 text-sm">
            {["text", "announcement", "forum", "voice", "files"].map((k) => (
              <option key={k} value={k}>
                {t(`channel.kind.${k}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("common.name")}>
          <Input name="channel_name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        {categories.length > 0 && (
          <Field label={t("channel.category")}>
            <select name="category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="min-h-10 w-full rounded-md border border-line bg-bg-0 px-3 text-sm">
              <option value="">{t("common.none")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryName(c)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function InviteDialog({ roomId, open, onClose }: { roomId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Validity (design note 4.13 item 8): up to 30 days with create_invites, "never" only with manage_room.
  const room = useRoom(roomId);
  const manage = !!room.data && hasPermission(parsePermissions(room.data.my_permissions), Permission.MANAGE_ROOM);
  const [hours, setHours] = useState(DEFAULT_EXPIRY_HOURS);
  const { api, home, domain } = useNode();
  // Invite links open the web client of the room's node.
  const web = useNodes((s) => (home ? homeWeb() : (s.sessions[domain]?.web ?? `https://${domain}`)));
  const close = () => {
    setLink(null);
    onClose();
  };
  const create = async () => {
    setBusy(true);
    try {
      const invite = await api.invites.create(roomId, { max_uses: 0, expires_hours: hours });
      setLink(`${web}/invite/${invite.code}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("invite.dialog.title")} open={open} onClose={close}>
      {link ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-1">{hours === 0 ? t("invite.link_never") : t("invite.link_valid_for", { duration: t(`invite.expiry.${hours}`) })}</p>
          <Input readOnly value={link} data-testid="invite-link" onFocus={(e) => e.currentTarget.select()} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(link)}>
              {t("common.copy")}
            </Button>
            <Button onClick={close}>{t("common.done")}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-1">{t("invite.create_hint")}</p>
          <label className="flex flex-col gap-1 text-xs text-fg-2">
            {t("invites.expires")}
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="min-h-10 w-full rounded-md border border-line bg-bg-0 px-3 text-sm" data-testid="invite-dialog-expiry">
              {expiryChoices(manage).map((h) => (
                <option key={h} value={h}>
                  {t(`invite.expiry.${h}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void create()} disabled={busy}>
              {t("invite.create")}
            </Button>
          </div>
          <DirectInviteForm roomId={roomId} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Invites one person of any node by address (FEDERATION.md §3.4): a single-use invite bound to them lands
 * in their invite list (on their home node for users of other nodes).
 */
function DirectInviteForm({ roomId }: { roomId: string }) {
  const t = useT();
  const { api } = useNode();
  const [user, setUser] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const { invite } = await api.invites.direct(roomId, user.trim());
      useToasts.getState().push({ kind: "info", title: t("invite.direct_sent", { address: invite.user ?? user.trim() }) });
      setUser("");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-2 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (user.trim()) void send();
      }}
    >
      <Field label={t("invite.direct_label")} hint={t("invite.direct_hint")}>
        <Input name="invite_user" value={user} onChange={(e) => setUser(e.target.value)} placeholder="name@node.example" autoComplete="off" />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end">
        <Button type="submit" variant="ghost" disabled={busy || !user.trim()}>
          {t("invite.direct_send")}
        </Button>
      </div>
    </form>
  );
}
