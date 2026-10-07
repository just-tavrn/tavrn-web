// SPDX-License-Identifier: Apache-2.0
/**
 * Node admin: provider groups → node rights for SSO logins (tavrn-protocol/APPLICATIONS.md §8.5). Every change
 * saves the whole map at once (`PUT /admin/sso/group-map`); it takes effect at the users' next SSO login.
 * A map set by `TAVRN_OIDC_GROUP_MAP` is read-only here (`409 sso.group_map_fixed`).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupMapDocument, GroupRights, RoomGrant } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { useT } from "../../i18n";
import { describeError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { Section, Textarea } from "../settings/common";

/** One room per line: the room id, then optionally role ids, separated by spaces or commas. */
export function parseRooms(text: string): RoomGrant[] {
  return text
    .split("\n")
    .map((line) => line.split(/[\s,]+/).filter(Boolean))
    .filter((parts) => parts.length > 0)
    .map(([room, ...roles]) => ({ room: room!, roles }));
}

export function formatRooms(rooms: RoomGrant[] | undefined): string {
  return (rooms ?? []).map((r) => [r.room, ...(r.roles ?? [])].join(" ")).join("\n");
}

/** A count field: empty means "not granted by this group". */
function toCount(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : null;
}

/** The rights of the form, without the unset ones (the server omits them too). */
export function buildRights(form: { nodeAdmin: boolean; roomCreation: string; appCreation: string; rooms: string }): GroupRights {
  const rights: GroupRights = {};
  if (form.nodeAdmin) rights.node_admin = true;
  const room = toCount(form.roomCreation);
  if (room !== null) rights.room_creation = room;
  const app = toCount(form.appCreation);
  if (app !== null) rights.app_creation = app;
  const rooms = parseRooms(form.rooms);
  if (rooms.length) rights.rooms = rooms;
  return rights;
}

const EMPTY = { group: "", nodeAdmin: false, roomCreation: "", appCreation: "", rooms: "" };

export function SsoGroupMapTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const doc = useQuery({ queryKey: ["admin", "sso-group-map"], queryFn: () => api.oidc.groupMap() });
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (map: GroupMapDocument["map"]): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.oidc.setGroupMap({ map });
      queryClient.setQueryData(["admin", "sso-group-map"], saved);
      useToasts.getState().push({ kind: "info", title: t("admin.sso.saved") });
      return true;
    } catch (e) {
      // An invalid map: the server's detail names the offending entry.
      const problem = (e as { problem?: { code?: string; detail?: string } }).problem;
      const message = describeError(e);
      setError(problem?.code === "sso.group_map_invalid" && problem.detail && !message.includes(problem.detail) ? `${message} (${problem.detail})` : message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (doc.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (doc.isError) return <p className="text-sm text-danger">{describeError(doc.error)}</p>;
  const { map, fixed, sync } = doc.data;
  const groups = Object.keys(map).sort();
  const group = form.group.trim();

  return (
    <Section title={t("admin.sso.title")} description={t("admin.sso.hint")}>
      <p className="text-xs text-fg-2" data-testid="admin-sso-sync">
        {t(sync === "sync" ? "admin.sso.sync_sync" : "admin.sso.sync_add")}
      </p>
      {fixed && (
        <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-fg-1" data-testid="admin-sso-fixed">
          {t("admin.sso.fixed")}
        </p>
      )}
      <ul className="divide-y divide-line" data-testid="admin-sso-map">
        {groups.map((name) => (
          <MappingRow
            key={name}
            name={name}
            rights={map[name]!}
            readOnly={fixed}
            busy={busy}
            onEdit={() => {
              const r = map[name]!;
              setForm({ group: name, nodeAdmin: !!r.node_admin, roomCreation: r.room_creation == null ? "" : String(r.room_creation), appCreation: r.app_creation == null ? "" : String(r.app_creation), rooms: formatRooms(r.rooms) });
            }}
            onRemove={() => {
              const next = { ...map };
              delete next[name];
              void save(next);
            }}
          />
        ))}
        {groups.length === 0 && <li className="py-2 text-sm text-fg-2">{t("admin.sso.none")}</li>}
      </ul>
      {!fixed && (
        <form
          className="space-y-3 rounded-md border border-line p-3"
          data-testid="admin-sso-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!group) return;
            if (await save({ ...map, [group]: buildRights(form) })) setForm(EMPTY);
          }}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label={t("admin.sso.group")}>
              <Input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} maxLength={256} required data-testid="admin-sso-group" />
            </Field>
            <Field label={t("admin.sso.room_creation")} hint={t("admin.sso.count_hint")}>
              <Input type="number" min={0} max={1000} value={form.roomCreation} onChange={(e) => setForm({ ...form, roomCreation: e.target.value })} data-testid="admin-sso-room-creation" />
            </Field>
            <Field label={t("admin.sso.app_creation")} hint={t("admin.sso.count_hint")}>
              <Input type="number" min={0} max={1000} value={form.appCreation} onChange={(e) => setForm({ ...form, appCreation: e.target.value })} data-testid="admin-sso-app-creation" />
            </Field>
          </div>
          <label className="flex min-h-9 items-center gap-2 text-sm text-fg-1">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={form.nodeAdmin} onChange={(e) => setForm({ ...form, nodeAdmin: e.target.checked })} data-testid="admin-sso-node-admin" />
            {t("admin.sso.node_admin")}
          </label>
          <Field label={t("admin.sso.rooms")} hint={t("admin.sso.rooms_hint")}>
            <Textarea rows={3} value={form.rooms} onChange={(e) => setForm({ ...form, rooms: e.target.value })} spellCheck={false} className="font-mono" data-testid="admin-sso-rooms" />
          </Field>
          {error && (
            <p className="text-sm text-danger" role="alert" data-testid="admin-sso-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {form !== EMPTY && (
              <Button variant="ghost" onClick={() => setForm(EMPTY)}>
                {t("common.cancel")}
              </Button>
            )}
            <Button type="submit" disabled={busy || !group} data-testid="admin-sso-add">
              {group in map ? t("admin.sso.update") : t("admin.sso.add")}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function MappingRow({ name, rights, readOnly, busy, onEdit, onRemove }: { name: string; rights: GroupRights; readOnly: boolean; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const t = useT();
  const parts: string[] = [];
  if (rights.node_admin) parts.push(t("admin.sso.node_admin"));
  if (rights.room_creation != null) parts.push(`${t("admin.sso.room_creation")}: ${rights.room_creation}`);
  if (rights.app_creation != null) parts.push(`${t("admin.sso.app_creation")}: ${rights.app_creation}`);
  return (
    <li className="flex flex-wrap items-start gap-2 py-2 text-sm" data-testid="admin-sso-mapping" data-group={name}>
      <div className="min-w-0 flex-1 basis-56 space-y-0.5">
        <span className="block break-all font-medium">{name}</span>
        <span className="block text-xs text-fg-1">{parts.length ? parts.join(" · ") : t("admin.sso.no_rights")}</span>
        {(rights.rooms ?? []).map((r) => (
          <span key={r.room} className="block break-all font-mono text-[11px] text-fg-2">
            {r.roles?.length ? t("admin.sso.room_roles", { room: r.room, roles: r.roles.join(", ") }) : t("admin.sso.room", { room: r.room })}
          </span>
        ))}
      </div>
      {!readOnly && (
        <div className="flex gap-1">
          <Button variant="ghost" disabled={busy} onClick={onEdit} data-testid="admin-sso-edit">
            {t("admin.sso.edit")}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onRemove} aria-label={t("admin.sso.remove_label", { group: name })} data-testid="admin-sso-remove">
            {t("admin.sso.remove")}
          </Button>
        </div>
      )}
    </li>
  );
}
