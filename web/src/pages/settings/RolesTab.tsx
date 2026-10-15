// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { EVERYONE_RESTRICTED, Permission, UPLOAD_CATEGORIES, hasPermission, parsePermissions, type Role, type RoomDetail } from "@tavrn/sdk";
import { canManageRole, planRoleReorder, sortRoles, topPosition } from "../../lib/hierarchy";
import { safeColor } from "../../lib/untrusted";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { useAction } from "../../hooks/useAction";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, PermissionCheckboxes, Section } from "./common";
import { useRoomPreview } from "../../stores/rolePreview";
import { ViewAsRole } from "./ViewAsRole";
import { patchRoom, withRole, withoutRole, type RoomPatch } from "../../lib/roomCache";

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
  // `?role=<id>`: opened from elsewhere (the room overview's file types link to @everyone).
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string>(params.get("role") ?? roles[0]?.id ?? everyone?.id ?? "");
  const selected = room.roles.find((r) => r.id === selectedId) ?? roles[0] ?? everyone;
  const queryClient = useQueryClient();
  const myPerms = parsePermissions(room.my_permissions);
  const canManage = hasPermission(myPerms, Permission.MANAGE_ROLES);
  const myTop = topPosition(room.roles, room.my_roles, room.is_owner);
  // Mutation answers go straight into the cached room (lib/roomCache.ts); the realtime events confirm them.
  const apply = (patch: RoomPatch) => patchRoom(queryClient, room.id, patch);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const previewing = !!useRoomPreview(room.id);

  const createRole = async () => {
    try {
      const role = await api.roles.create(room.id, { name: t("roles.new_name"), position: 1, permissions: "0" });
      apply(withRole(role));
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
      for (const u of plan.updates) apply(withRole(await api.roles.update(room.id, u.id, { position: u.position })));
      useToasts.getState().push({ kind: "info", title: t("members.reorder_saved") });
    } catch (e) {
      toastError(e);
      // A partly saved order: the node's state decides.
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
    } finally {
      setBusy(false);
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
                  <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: safeColor(r.color) ?? "#7c8494" }} aria-hidden="true" />
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
      {selected && (
        <div className="min-w-0 space-y-4">
          {/* The role preview starts from here (not inside one: there the tab is read-only). */}
          {canManage && !previewing && <ViewAsRole key={`view-${selected.id}`} room={room} role={selected} />}
          <RoleEditor key={selected.id} role={selected} room={room} canManage={canManage && (selected.is_everyone || selected.position < myTop)} myPerms={myPerms} onChanged={apply} managedBy={managedBy(selected)} />
        </div>
      )}
    </div>
  );
}

/** The editable fields of a role. */
interface RoleForm {
  name: string;
  color: string;
  useColor: boolean;
  position: number;
  hoist: boolean;
  mentionable: boolean;
  perms: bigint;
  uploads: string[] | null;
}

function formOf(role: Role): RoleForm {
  return {
    name: role.name,
    color: role.color ?? "#33aea6",
    useColor: !!role.color,
    position: role.position,
    hoist: role.hoist,
    mentionable: role.mentionable,
    perms: parsePermissions(role.permissions),
    uploads: role.allowed_upload_categories ?? (role.is_everyone ? [...UPLOAD_CATEGORIES] : null),
  };
}

/** Equal as far as the node stores it (the colour only counts while one is used). */
function sameForm(a: RoleForm, b: RoleForm): boolean {
  return a.name === b.name && a.useColor === b.useColor && (!a.useColor || a.color.toLowerCase() === b.color.toLowerCase()) && a.position === b.position && a.hoist === b.hoist && a.mentionable === b.mentionable && a.perms === b.perms && JSON.stringify(a.uploads) === JSON.stringify(b.uploads);
}

/**
 * The form is derived from the role once. A newer version of the role (another admin, a realtime update) replaces an
 * untouched form; while the user edits, their edits stay and a notice offers the newer version instead of overwriting
 * a part of the form (which would save old and new fields mixed).
 */
function RoleEditor({ role, room, canManage, myPerms, onChanged, managedBy }: { role: Role; room: RoomDetail; canManage: boolean; myPerms: bigint; onChanged: (patch: RoomPatch) => void; managedBy: string | null }) {
  const { api } = useNode();
  const t = useT();
  const [form, setForm] = useState(() => formOf(role));
  /** The version the form started from. */
  const [base, setBase] = useState(role);
  /** The last role prop handled (adjusting state while rendering, without an effect). */
  const [seen, setSeen] = useState(role);
  if (role !== seen) {
    setSeen(role);
    const fresh = formOf(role);
    if (sameForm(form, formOf(base)) || sameForm(form, fresh)) {
      setForm(fresh);
      setBase(role);
    }
  }
  const changedElsewhere = !sameForm(formOf(base), formOf(role));
  const set = (patch: Partial<RoleForm>) => setForm((f) => ({ ...f, ...patch }));
  const { name, color, useColor, position, hoist, mentionable, perms, uploads } = form;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { run, busy } = useAction();
  const roomDefault = room.roles.find((r) => r.is_everyone)?.allowed_upload_categories ?? [...UPLOAD_CATEGORIES];

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    // Only a changed setting is sent: the room overview edits @everyone's too.
    const uploadsChanged = JSON.stringify(uploads) !== JSON.stringify(formOf(base).uploads);
    const extra = uploadsChanged ? { allowed_upload_categories: uploads } : {};
    void run(() => api.roles.update(room.id, role.id, role.is_everyone ? { permissions: perms.toString(), ...extra } : { name, color: useColor ? color : null, position, hoist, mentionable, permissions: perms.toString(), ...extra }), {
      done: t("roles.saved"),
      refresh: (saved) => onChanged(withRole(saved)),
    });
  };

  return (
    <form onSubmit={save} className="space-y-4" data-testid="role-editor">
      {changedElsewhere && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg-0" data-testid="role-changed-elsewhere">
          <span className="min-w-0 flex-1">{t("roles.changed_elsewhere")}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setForm(formOf(role));
              setBase(role);
            }}
            data-testid="role-changed-reload"
          >
            {t("roles.changed_reload")}
          </Button>
        </div>
      )}
      <Section title={role.is_everyone ? t("roles.everyone") : t("roles.role", { name: role.name })} description={canManage ? undefined : t("roles.readonly")}>
        {managedBy && (
          <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="role-managed-by">
            🤖 {t("roles.managed_by", { name: managedBy })} {t("roles.managed_hint")}
          </p>
        )}
        {!role.is_everyone && (
          <>
            <Field label={t("common.name")}>
              <Input value={name} onChange={(e) => set({ name: e.target.value })} disabled={!canManage} maxLength={100} required />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("roles.position")} hint={t("roles.position_hint")}>
                <Input type="number" min={1} max={10000} value={position} onChange={(e) => set({ position: Number(e.target.value) })} disabled={!canManage} />
              </Field>
              <Field label={t("roles.color")}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4" checked={useColor} onChange={(e) => set({ useColor: e.target.checked })} disabled={!canManage} aria-label={t("roles.use_color")} />
                  <input type="color" value={color} onChange={(e) => set({ color: e.target.value })} disabled={!canManage || !useColor} aria-label={t("roles.color_value")} className="h-10 w-16 rounded border border-line bg-bg-0" />
                </div>
              </Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={hoist} onChange={(e) => set({ hoist: e.target.checked })} disabled={!canManage} /> {t("roles.hoist")}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4" checked={mentionable} onChange={(e) => set({ mentionable: e.target.checked })} disabled={!canManage} /> {t("roles.mentionable")}
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
          <PermissionCheckboxes value={perms} onChange={(next) => set({ perms: next })} limit={room.is_owner ? undefined : myPerms} idPrefix={`role-${role.id}`} restricted={role.is_everyone ? EVERYONE_RESTRICTED : 0n} />
        </fieldset>
      </Section>
      <RoleUploadCategories roomId={room.id} role={role} value={uploads} onChange={(next) => set({ uploads: next })} roomDefault={roomDefault} disabled={!canManage} />
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          {!role.is_everyone && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t("roles.delete")}
            </Button>
          )}
          <Button type="submit" disabled={busy}>
            {t("common.save")}
          </Button>
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
          onChanged(withoutRole(role.id));
        }}
      />
    </form>
  );
}

/**
 * "Allowed file types" of a role (tavrn-protocol permissions.md "Upload categories"): a list, or for roles other than
 * @everyone "not set", where the member's highest role with a setting decides, else @everyone (the room default,
 * shown greyed). @everyone's list is also in the room overview.
 */
function RoleUploadCategories({ roomId, role, value, onChange, roomDefault, disabled }: { roomId: string; role: Role; value: string[] | null; onChange: (next: string[] | null) => void; roomDefault: string[]; disabled: boolean }) {
  const t = useT();
  const { roomPath } = useNode();
  const shown = value ?? roomDefault;
  const toggle = (category: string, on: boolean) => onChange(UPLOAD_CATEGORIES.filter((c) => (c === category ? on : shown.includes(c))));
  return (
    <Section title={t("roles.uploads_title")} description={t(role.is_everyone ? "roles.uploads_everyone_hint" : "roles.uploads_hint")}>
      <div className="space-y-3" data-testid="role-uploads">
        {!role.is_everyone && (
          <label className="flex min-h-10 items-start gap-2 text-sm text-fg-1">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={value === null} disabled={disabled} onChange={(e) => onChange(e.target.checked ? null : [...roomDefault])} data-testid="role-uploads-inherit" />
            <span>
              {t("roles.uploads_inherit")}
              <span className="block text-xs text-fg-2">{t("roles.uploads_inherit_hint")}</span>
            </span>
          </label>
        )}
        <fieldset disabled={disabled || value === null} className="disabled:opacity-60">
          <legend className="sr-only">{t("roles.uploads_title")}</legend>
          <div className="grid gap-1 sm:grid-cols-3">
            {UPLOAD_CATEGORIES.map((c) => (
              <label key={c} className="flex min-h-9 items-center gap-2 text-sm text-fg-1">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={shown.includes(c)} onChange={(e) => toggle(c, e.target.checked)} data-testid={`role-upload-${c}`} />
                {t(`upload.category.${c}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-fg-2">{t("upload.executables_hint")}</p>
        {role.is_everyone && (
          <p className="text-xs">
            <Link to={roomPath(roomId, undefined, "settings/overview")} className="text-accent underline underline-offset-2 hover:text-accent-hover">
              {t("roles.uploads_overview_link")}
            </Link>
          </p>
        )}
      </div>
    </Section>
  );
}
