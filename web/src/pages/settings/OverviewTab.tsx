// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { TransferSection } from "../../moderation/TransferOwnership";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Permission, hasPermission, isBotKind, parsePermissions, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { indexLeftRoom } from "../../stores/conversationIndex";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, Section, Select, Textarea } from "./common";
import { RoomIconSection } from "./RoomIconSection";
import { RoomPresenceSection } from "./RoomPresenceSection";
import { RetentionSection } from "./RetentionSection";
import { BotsInEncryptedSection } from "./BotsEncryptionSection";
import { UPLOAD_CATEGORIES } from "../../lib/uploads";
import { AgeGateSection } from "../../components/age/AgeGateSection";

export function OverviewTab({ room }: { room: RoomDetail }) {
  const { api, home, domain } = useNode();
  const t = useT();
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description);
  const [rules, setRules] = useState(room.rules);
  const [joinMode, setJoinMode] = useState(room.join_mode);
  const [discoverable, setDiscoverable] = useState(room.discoverable);
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const perms = parsePermissions(room.my_permissions);
  const canManage = hasPermission(perms, Permission.MANAGE_ROOM);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Only public rooms can be listed; the node also unlists a room that stops being public.
      const listed = joinMode === "public" && discoverable;
      await api.rooms.update(room.id, { name, description, rules, join_mode: joinMode, discoverable: listed });
      setDiscoverable(listed);
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={save}>
        <Section title={t("settings.overview")} description={canManage ? undefined : t("settings.overview.readonly")}>
          <Field label={t("common.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={100} required />
          </Field>
          <Field label={t("settings.description")}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canManage} rows={2} maxLength={1000} />
          </Field>
          <Field label={t("settings.rules")} hint={t("settings.rules_hint")}>
            <Textarea value={rules} onChange={(e) => setRules(e.target.value)} disabled={!canManage} rows={4} maxLength={10000} />
          </Field>
          <Field label={t("room.join_mode")}>
            <Select value={joinMode} onChange={(e) => setJoinMode(e.target.value)} disabled={!canManage}>
              <option value="invite">{t("room.join_mode.invite")}</option>
              <option value="public">{t("room.join_mode.public")}</option>
            </Select>
          </Field>
          {/* Directory listing (FEDERATION.md §7.3): visible on Discover here and on other nodes. */}
          <div className="space-y-1 text-sm">
            <label className="flex min-h-10 items-center gap-2 text-fg-1">
              <input type="checkbox" name="discoverable" className="h-4 w-4 accent-accent" checked={joinMode === "public" && discoverable} onChange={(e) => setDiscoverable(e.target.checked)} disabled={!canManage || joinMode !== "public"} data-testid="room-discoverable" />
              {t("settings.discoverable")}
            </label>
            <span className="block text-xs text-fg-2">
              {t("settings.discoverable_hint")}
              {canManage && joinMode !== "public" && ` ${t("settings.discoverable_public_only")}`}
            </span>
          </div>
          {canManage && (
            <div className="flex justify-end">
              <Button type="submit" data-testid="overview-save">
                {t("common.save")}
              </Button>
            </div>
          )}
        </Section>
      </form>

      <AgeGateSection
        scope="room"
        value={room.age_gate}
        canManage={canManage}
        onSave={async (gate) => {
          await api.rooms.update(room.id, { age_gate: gate });
          await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
        }}
      />
      <RoomIconSection room={room} />
      <RoomPresenceSection room={room} />
      <NoBotsSection room={room} canManage={canManage} />
      <BotsInEncryptedSection room={room} canManage={canManage} />
      <UploadCategoriesSection room={room} />
      <RetentionSection room={room} />

      <TransferSection room={room} />

      <Section title={t("settings.danger")}>
        <div className="flex flex-wrap gap-2">
          {!room.is_owner && (
            <Button variant="danger" onClick={() => setConfirm("leave")}>
              {t("room.leave")}
            </Button>
          )}
          {room.is_owner && (
            <Button variant="danger" onClick={() => setConfirm("delete")}>
              {t("room.delete")}
            </Button>
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={confirm === "delete"}
        title={t("room.delete_title")}
        text={t("room.delete_text", { name: room.name })}
        confirmWord={room.name}
        actionLabel={t("room.delete_action")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.rooms.delete(room.id);
          void indexLeftRoom(home ? null : domain, room.id);
          await queryClient.invalidateQueries({ queryKey: ["rooms"] });
          navigate("/");
        }}
      />
      <ConfirmDialog
        open={confirm === "leave"}
        title={t("room.leave")}
        text={t("room.leave_text")}
        actionLabel={t("room.leave_action")}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.rooms.leave(room.id);
          void indexLeftRoom(home ? null : domain, room.id);
          await queryClient.invalidateQueries({ queryKey: ["rooms"] });
          navigate("/");
        }}
      />
    </div>
  );
}

/**
 * "No bots" for the whole room (APPLICATIONS.md §3.5, owner or `manage_room`): switching it on removes every bot
 * of the room after a confirmation that names how many will go; new bots are refused.
 */
function NoBotsSection({ room, canManage }: { room: RoomDetail; canManage: boolean }) {
  const { api } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const apply = async (next: boolean) => {
    setBusy(true);
    try {
      await api.rooms.update(room.id, { no_bots: next });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
      await queryClient.invalidateQueries({ queryKey: ["members", room.id] });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (next: boolean) => {
    if (!next) return apply(false);
    try {
      const members = await api.members.list(room.id, { limit: 200 });
      setConfirmCount(members.filter((m) => isBotKind(m.user.kind)).length);
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Section title={t("apps.no_bots.room_title")} description={t("apps.no_bots.room_hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={room.no_bots} disabled={!canManage || busy} onChange={(e) => void toggle(e.target.checked)} data-testid="room-no-bots" />
        {t("apps.no_bots.toggle")}
      </label>
      <ConfirmDialog
        open={confirmCount !== null}
        title={t("apps.no_bots.room_title")}
        text={t("apps.no_bots.confirm", { count: String(confirmCount ?? 0) })}
        actionLabel={t("apps.no_bots.confirm_action")}
        onClose={() => setConfirmCount(null)}
        onConfirm={async () => {
          await apply(true);
          setConfirmCount(null);
        }}
      />
    </Section>
  );
}

/**
 * Upload categories of `@everyone` (PROTOCOL.md §7a, `manage_roles`): the room-wide default. Roles and channel
 * overrides can widen or narrow it; executables additionally need the node setting.
 */
function UploadCategoriesSection({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const everyone = room.roles.find((r) => r.is_everyone);
  const canManage = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROLES);
  const [current, setCurrent] = useState<string[]>(everyone?.allowed_upload_categories ?? [...UPLOAD_CATEGORIES]);
  const [busy, setBusy] = useState(false);
  if (!everyone) return null;
  const toggle = async (category: string, on: boolean) => {
    const previous = current;
    const next = UPLOAD_CATEGORIES.filter((c) => (c === category ? on : current.includes(c)));
    setCurrent(next);
    setBusy(true);
    try {
      await api.roles.update(room.id, everyone.id, { allowed_upload_categories: next });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
    } catch (err) {
      setCurrent(previous);
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("upload.settings_title")} description={t("upload.settings_hint")}>
      <div className="grid gap-1 sm:grid-cols-3" data-testid="upload-categories">
        {UPLOAD_CATEGORIES.map((c) => (
          <label key={c} className="flex min-h-9 items-center gap-2 text-sm text-fg-1">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={current.includes(c)} disabled={!canManage || busy} onChange={(e) => void toggle(c, e.target.checked)} data-testid={`upload-category-${c}`} />
            {t(`upload.category.${c}`)}
          </label>
        ))}
      </div>
      <p className="text-xs text-fg-2">{t("upload.executables_hint")}</p>
    </Section>
  );
}
