// SPDX-License-Identifier: Apache-2.0
/**
 * The applications installed in a room (tavrn-protocol/APPLICATIONS.md §4.3, `manage_applications`): bot, granted permissions,
 * managed role, installer; uninstall with confirmation; "Add an application" with an add link.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { PERMISSION_LABELS, Permission, hasPermission, parsePermissions, type Installation, type PermissionName, type RoomCommand, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { UserAvatar } from "../../components/Avatar";
import { BotBadge } from "../../components/Badges";
import { AddApplicationForm } from "../../components/AddApplicationForm";
import { describeError, useToasts } from "../../stores/toasts";
import { intlLocale, useT } from "../../i18n";
import { Button } from "../../components/ui";
import { ConfirmDialog, Section, usePermissionLabel } from "./common";

export function installationsKey(domain: string, roomId: string) {
  return ["installations", domain, roomId];
}

export function RoomApplicationsTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api, domain, home } = useNode();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: installationsKey(domain, room.id), queryFn: () => api.applications.installed(room.id) });
  const [removing, setRemoving] = useState<Installation | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: installationsKey(domain, room.id) }), queryClient.invalidateQueries({ queryKey: ["room", room.id] })]);
  return (
    <div className="space-y-4" data-testid="room-applications">
      <Section title={t("roomapps.title")} description={t("roomapps.hint")}>
        {list.isError && <p className="text-sm text-danger">{describeError(list.error)}</p>}
        {list.data?.length === 0 && <p className="text-sm text-fg-2">{t("roomapps.none")}</p>}
        <ul className="divide-y divide-line" data-testid="room-application-list">
          {list.data?.map((i) => (
            <InstallationRow key={i.application.ref} installation={i} room={room} onRemove={() => setRemoving(i)} />
          ))}
        </ul>
      </Section>
      <Section title={t("addapp.title")} description={room.no_bots ? t("roomapps.no_bots") : t("roomapps.add_hint")}>
        <AddApplicationForm room={{ node: home ? null : domain, id: room.id }} onOpen={(path) => navigate(path)} />
      </Section>
      <ConfirmDialog
        open={!!removing}
        title={t("roomapps.remove_title", { name: removing?.application.name ?? "" })}
        text={t("roomapps.remove_text")}
        actionLabel={t("roomapps.remove")}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await api.applications.uninstall(room.id, removing.application.ref);
          setRemoving(null);
          useToasts.getState().push({ kind: "info", title: t("roomapps.removed", { name: removing.application.name }) });
          await refresh();
        }}
      />
    </div>
  );
}

function InstallationRow({ installation: i, room, onRemove }: { installation: Installation; room: RoomDetail; onRemove: () => void }) {
  const t = useT();
  const [commandsOpen, setCommandsOpen] = useState(false);
  const { label } = usePermissionLabel();
  const perms = parsePermissions(i.permissions);
  const names = PERMISSION_LABELS.filter((p) => hasPermission(perms, Permission[p.name as PermissionName])).map((p) => label(p.name as PermissionName));
  const role = room.roles.find((r) => r.id === i.role_id);
  return (
    <li className="py-3" data-testid="room-application-row" data-ref={i.application.ref}>
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar user={i.bot} size={36} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium">{i.application.name}</span>
            <BotBadge />
          </p>
          <p className="truncate font-mono text-xs text-fg-2">{i.bot.address}</p>
          <p className="text-xs text-fg-2">
            {role ? t("roomapps.role", { role: role.name }) : t("roomapps.no_role")}
            {names.length > 0 && ` · ${names.join(", ")}`}
          </p>
          <p className="text-[11px] text-fg-2">{t("roomapps.installed_by", { user: i.installed_by, date: new Date(i.installed_at).toLocaleDateString(intlLocale()) })}</p>
        </div>
      </div>
      <div className="flex gap-2 self-end sm:self-auto">
        <Button variant="ghost" aria-expanded={commandsOpen} onClick={() => setCommandsOpen((v) => !v)} data-testid="room-application-commands">
          {t("roomapps.commands", { count: i.enabled_commands })}
        </Button>
        <Button variant="ghost" className="text-danger" onClick={onRemove} data-testid="room-application-remove">
          {t("roomapps.remove")}
        </Button>
      </div>
    </div>
      {commandsOpen && <RoomCommandsPanel room={room} applicationRef={i.application.ref} />}
    </li>
  );
}

/**
 * The commands of one installed application in this room (APPLICATIONS.md §5.3): enabled, the roles that may use
 * them (none checked: no restriction) and the channels where they are disabled. Changes are saved at once.
 */
function RoomCommandsPanel({ room, applicationRef }: { room: RoomDetail; applicationRef: string }) {
  const t = useT();
  const { api, domain } = useNode();
  const queryClient = useQueryClient();
  const key = ["room-commands", domain, room.id];
  const list = useQuery({ queryKey: key, queryFn: () => api.commands.room(room.id) });
  const commands = list.data?.find((a) => a.application.ref === applicationRef)?.commands ?? [];
  const save = async (c: RoomCommand, next: RoomCommand["settings"]) => {
    try {
      await api.commands.setRoomSettings(room.id, c.ref, { enabled: next.enabled, permissions: next.permissions ?? null, allowed_roles: next.allowed_roles, disabled_channels: next.disabled_channels });
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: describeError(e) });
    }
    await Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: installationsKey(domain, room.id) })]);
  };
  return (
    <div className="mt-2 rounded-md border border-line bg-bg-1 p-2" data-testid="room-commands">
      {list.isError && <p className="text-sm text-danger">{describeError(list.error)}</p>}
      {list.isSuccess && commands.length === 0 && <p className="text-sm text-fg-2">{t("roomapps.commands_none")}</p>}
      <ul className="space-y-2">
        {commands.map((c) => (
          <RoomCommandRow key={c.ref} command={c} room={room} onSave={(next) => void save(c, next)} />
        ))}
      </ul>
    </div>
  );
}

/** One command: its settings are edited locally (shown at once) and saved on every change. */
function RoomCommandRow({ command: c, room, onSave }: { command: RoomCommand; room: RoomDetail; onSave: (next: RoomCommand["settings"]) => void }) {
  const t = useT();
  const [settings, setSettings] = useState(c.settings);
  useEffect(() => setSettings(c.settings), [c.settings]);
  const change = (patch: Partial<RoomCommand["settings"]>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    onSave(next);
  };
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id));
  const roles = room.roles.filter((r) => !r.is_everyone);
  const channels = room.channels.filter((ch) => ch.kind === "text" || ch.kind === "announcement" || ch.kind === "forum");
  return (
    <li className="text-sm" data-testid="room-command-row" data-name={c.command.name}>
      <label className="flex min-h-8 items-center gap-2">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => change({ enabled: e.target.checked })} data-testid="room-command-enabled" />
        <span className="font-mono font-semibold">/{c.command.name}</span>
        <span className="truncate text-xs text-fg-2">{c.command.description}</span>
        {!c.approved && <span className="text-xs text-warn" data-testid="room-command-pending">{t("roomapps.command_pending")}</span>}
      </label>
      <details className="ml-6 text-xs text-fg-1">
        <summary className="min-h-8 cursor-pointer py-1">{t("roomapps.command_restrict")}</summary>
        <fieldset className="mb-2">
          <legend className="text-fg-2">{t("roomapps.command_roles")}</legend>
          {roles.length === 0 && <p className="text-fg-2">{t("roomapps.command_no_roles")}</p>}
          {roles.map((r) => (
            <label key={r.id} className="mr-3 inline-flex min-h-8 items-center gap-1">
              <input type="checkbox" checked={settings.allowed_roles.includes(r.id)} onChange={(e) => change({ allowed_roles: toggle(settings.allowed_roles, r.id, e.target.checked) })} data-testid="room-command-role" data-role={r.name} />
              {r.name}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="text-fg-2">{t("roomapps.command_channels")}</legend>
          {channels.map((ch) => (
            <label key={ch.id} className="mr-3 inline-flex min-h-8 items-center gap-1">
              <input type="checkbox" checked={settings.disabled_channels.includes(ch.id)} onChange={(e) => change({ disabled_channels: toggle(settings.disabled_channels, ch.id, e.target.checked) })} data-testid="room-command-channel" data-channel={ch.name} />
              #{ch.name}
            </label>
          ))}
        </fieldset>
      </details>
    </li>
  );
}
