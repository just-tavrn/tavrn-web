// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EVERYONE_RESTRICTED, Permission, hasPermission, parsePermissions, type Role, type RoomDetail } from "@tavrn/sdk";
import { canManageRole, planRoleReorder, sortRoles, topPosition } from "../../lib/hierarchy";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, PermissionCheckboxes, Section } from "./common";

/**
 * "Managed by <application>" (APPLICATIONS.md §4.2): the name of the application whose installation created the
 * role, from the room's installations (`manage_applications` or `manage_room`), else its reference.
 */
function useManagedBy(room: RoomDetail): (role: Role) => string | null {
  const { api, domain } = useNode();
  const perms = parsePermissions(room.my_permissions);
  const manage = room.is_owner || hasPermission(perms, Permission.MANAGE_ROOM) || hasPermission(perms, Permission.MANAGE_APPLICATIONS);
  const any = room.roles.some((r) => !!r.application_id);
  const installed = useQuery({ queryKey: ["installations", domain, room.id], queryFn: () => api.applications.installed(room.id), enabled: manage && any, staleTime: 30_000 });
  return (role) => {
    if (!role.application_id) return null;
    return installed.data?.find((i) => i.application.ref === role.application_id)?.application.name ?? role.application_id;
  };
}

export function RolesTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const managedBy = useManagedBy(room);
  const t = useT();
  const roles = sortRoles(room.roles.filter((r) => !r.is_everyone));
  const everyone = room.roles.find((r) => r.is_everyone);
  const [selectedId, setSelectedId] = useState<string>(roles[0]?.id ?? everyone?.id ?? "");
  const selected = room.roles.find((r) => r.id === selectedId) ?? roles[0] ?? everyone;
  const queryClient = useQueryClient();
  const myPerms = parsePermissions(room.my_permissions);
  const canManage = hasPermission(myPerms, Permission.MANAGE_ROLES);
  const myTop = topPosition(room.roles, room.my_roles, room.is_owner);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["room", room.id] });
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const createRole = async () => {
    try {
      const role = await api.roles.create(room.id, { name: t("roles.new_name"), position: 1, permissions: "0" });
      await refresh();
      setSelectedId(role.id);
    } catch (e) {
      toastError(e);
    }
  };

  /** Drag and drop or the arrow buttons: plans the new positions (hierarchy rules) and saves them. */
  const move = async (roleId: string, targetIndex: number) => {
    const plan = planRoleReorder(room.roles, roleId, targetIndex, myTop);
    if (!plan.ok) {
      useToasts.getState().push({ kind: "warning", title: t(plan.reason === "no_room" ? "members.reorder_no_room" : "members.reorder_hierarchy") });
      return;
    }
    if (!plan.updates.length) return;
    setBusy(true);
    try {
      // Top-down: a role never passes one that has not been moved yet in a way the node would refuse.
      for (const u of plan.updates) await api.roles.update(room.id, u.id, { position: u.position });
      useToasts.getState().push({ kind: "info", title: t("members.reorder_saved") });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[240px_1fr]">
      <Section title={t("roles.title")} description={canManage ? t("members.reorder_hint") : t("roles.hint")}>
        <ul className="space-y-1" data-testid="role-list" aria-busy={busy}>
          {roles.map((r, index) => {
            const movable = canManage && canManageRole(r.position, myTop);
            return (
              <li
                key={r.id}
                data-testid="role-row"
                data-role={r.name}
                draggable={movable && !busy}
                onDragStart={(e) => {
                  setDragging(r.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", r.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOver(index);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = dragging ?? e.dataTransfer.getData("text/plain");
                  setDragging(null);
                  setOver(null);
                  if (id) void move(id, index);
                }}
                className={`group flex items-center gap-1 rounded-md ${over === index && dragging && dragging !== r.id ? "ring-2 ring-accent" : ""} ${dragging === r.id ? "opacity-50" : ""}`}
              >
                {canManage && (
                  <span aria-hidden="true" className={`w-4 shrink-0 select-none text-center text-fg-2 ${movable ? "cursor-grab" : "opacity-30"}`} title={movable ? t("members.reorder_drag") : t("members.reorder_locked")}>
                    ⋮⋮
                  </span>
                )}
                <button type="button" onClick={() => setSelectedId(r.id)} className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm ${selected?.id === r.id ? "bg-bg-3 text-fg-0" : "text-fg-1 hover:bg-bg-3/60"}`}>
                  <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: r.color ?? "#7c8494" }} aria-hidden="true" />
                  <span className="truncate">{r.name}</span>
                  {r.application_id && (
                    <span role="img" className="shrink-0 text-[10px]" title={t("roles.managed_by", { name: managedBy(r) ?? "" })} aria-label={t("roles.managed_by", { name: managedBy(r) ?? "" })} data-testid="role-managed-icon">
                      🤖
                    </span>
                  )}
                  {r.hoist && <span className="ml-auto shrink-0 text-[10px] text-fg-2" title={t("roles.hoist")}>☰</span>}
                </button>
                {movable && (
                  <span className="flex shrink-0 flex-col">
                    <button type="button" disabled={busy || index === 0} onClick={() => void move(r.id, index - 1)} aria-label={t("members.reorder_up", { name: r.name })} className="min-h-5 min-w-6 rounded text-[10px] text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-30">
                      ▲
                    </button>
                    <button type="button" disabled={busy || index === roles.length - 1} onClick={() => void move(r.id, index + 1)} aria-label={t("members.reorder_down", { name: r.name })} className="min-h-5 min-w-6 rounded text-[10px] text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-30">
                      ▼
                    </button>
                  </span>
                )}
              </li>
            );
          })}
          {everyone && (
            <li>
              <button type="button" onClick={() => setSelectedId(everyone.id)} className={`flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selected?.id === everyone.id ? "bg-bg-3 text-fg-0" : "text-fg-1 hover:bg-bg-3/60"}`}>
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: "#7c8494" }} aria-hidden="true" />
                <span className="truncate">{everyone.name}</span>
              </button>
            </li>
          )}
        </ul>
        {canManage && (
          <Button variant="ghost" className="w-full" onClick={() => void createRole()}>
            {t("roles.new")}
          </Button>
        )}
      </Section>
      {selected && <RoleEditor key={selected.id} role={selected} room={room} canManage={canManage && (selected.is_everyone || selected.position < myTop)} myPerms={myPerms} onChanged={refresh} managedBy={managedBy(selected)} />}
    </div>
  );
}

function RoleEditor({ role, room, canManage, myPerms, onChanged, managedBy }: { role: Role; room: RoomDetail; canManage: boolean; myPerms: bigint; onChanged: () => Promise<void>; managedBy: string | null }) {
  const { api } = useNode();
  const t = useT();
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? "#33aea6");
  const [useColor, setUseColor] = useState(!!role.color);
  const [position, setPosition] = useState(role.position);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [perms, setPerms] = useState(parsePermissions(role.permissions));
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setPerms(parsePermissions(role.permissions)), [role.permissions]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.roles.update(room.id, role.id, role.is_everyone ? { permissions: perms.toString() } : { name, color: useColor ? color : null, position, hoist, mentionable, permissions: perms.toString() });
      await onChanged();
      useToasts.getState().push({ kind: "info", title: t("roles.saved") });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4" data-testid="role-editor">
      <Section title={role.is_everyone ? t("roles.everyone") : t("roles.role", { name: role.name })} description={canManage ? undefined : t("roles.readonly")}>
        {managedBy && (
          <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="role-managed-by">
            🤖 {t("roles.managed_by", { name: managedBy })} {t("roles.managed_hint")}
          </p>
        )}
        {!role.is_everyone && (
          <>
            <Field label={t("common.name")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={100} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("roles.position")} hint={t("roles.position_hint")}>
                <Input type="number" min={1} max={10000} value={position} onChange={(e) => setPosition(Number(e.target.value))} disabled={!canManage} />
              </Field>
              <Field label={t("roles.color")}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={useColor} onChange={(e) => setUseColor(e.target.checked)} disabled={!canManage} aria-label={t("roles.use_color")} />
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={!canManage || !useColor} aria-label={t("roles.color_value")} className="h-10 w-16 rounded border border-line bg-bg-0" />
                </div>
              </Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={hoist} onChange={(e) => setHoist(e.target.checked)} disabled={!canManage} /> {t("roles.hoist")}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={mentionable} onChange={(e) => setMentionable(e.target.checked)} disabled={!canManage} /> {t("roles.mentionable")}
              </label>
            </div>
          </>
        )}
      </Section>
      <Section title={t("roles.permissions")} description={t("roles.permissions_hint")}>
        {role.is_everyone && (
          <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="everyone-restricted-note">
            🔒 {t("members.everyone_restricted")}
          </p>
        )}
        <fieldset disabled={!canManage}>
          <PermissionCheckboxes value={perms} onChange={setPerms} limit={room.is_owner ? undefined : myPerms} idPrefix={`role-${role.id}`} restricted={role.is_everyone ? EVERYONE_RESTRICTED : 0n} />
        </fieldset>
      </Section>
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          {!role.is_everyone && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t("roles.delete")}
            </Button>
          )}
          <Button type="submit">{t("common.save")}</Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={t("roles.delete")}
        text={t("roles.delete_text", { name: role.name })}
        actionLabel={t("common.delete")}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api.roles.delete(room.id, role.id);
          setConfirmDelete(false);
          await onChanged();
        }}
      />
    </form>
  );
}
