// SPDX-License-Identifier: Apache-2.0
import { AgeGateSection } from "../../components/age/AgeGateSection";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EVERYONE_RESTRICTED, Permission, UPLOAD_CATEGORIES, hasPermission, inheritedOverrideValue, parsePermissions, type Category, type Channel, type RoomDetail } from "@tavrn/sdk";
import { useSearchParams } from "react-router";
import { useNode } from "../../components/NodeScope";
import { useT } from "../../i18n";
import { toastError, useToasts } from "../../stores/toasts";
import { useAction } from "../../hooks/useAction";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, OverrideTriState, Section, Select, TriStateRow } from "./common";
import { effectiveUploads, inheritedUpload, overrideUploadState, setOverrideUpload, type UploadOverrideInput, type UploadSubject } from "../../lib/uploadPolicy";
import { categoryName, channelName } from "../../lib/names";
import { LockMark, accessMarkKey } from "../../components/Badges";
import { GroupOffIcon } from "../../components/icons";
import { channelPrivacy } from "../../lib/channelPermissions";
import { ChannelBotsAllowed } from "./BotsEncryptionSection";
import { HistoryPolicySection } from "./HistoryPolicy";
import { ThreadSettingsSection } from "../../threads/ThreadSettings";
import { StorageSection } from "../../files/StorageSection";
import { FilesDeletionFacts, deletionCase } from "../../files/DeleteChannel";
import { VoiceQualitySection } from "./VoiceQualitySection";
import { planChannelMove } from "../../lib/channelOrder";
import { ChannelTree, useOrderSaver } from "./ChannelTree";
import { patchRoom, withCategory, withChannel, withOverrides, withoutCategory, withoutChannel, withoutOverrides, type RoomPatch } from "../../lib/roomCache";

export function ChannelsTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  // `?channel=<id>`: opened from a channel's context menu ("Edit channel"); otherwise the first regular
  // channel (the welcome channel, kind "system", is fixed).
  // `?category=<id>`: the category's permissions.
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState(params.get("channel") ?? (room.channels.find((c) => c.kind !== "system") ?? room.channels[0])?.id ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(params.get("category"));
  const selectedCategory = room.categories.find((c) => c.id === categoryId) ?? null;
  const selected = room.channels.find((c) => c.id === selectedId) ?? room.channels[0];
  const selectChannel = (id: string) => {
    setCategoryId(null);
    setSelectedId(id);
  };
  const [newCategory, setNewCategory] = useState("");
  const queryClient = useQueryClient();
  const perms = parsePermissions(room.my_permissions);
  const canManage = hasPermission(perms, Permission.MANAGE_CHANNELS);
  const canManageRoles = hasPermission(perms, Permission.MANAGE_ROLES);
  // Mutation answers go straight into the cached room (lib/roomCache.ts); the realtime events confirm them. Without
  // an answer to write the room is refetched.
  const apply = async (patch?: RoomPatch) => (patch ? patchRoom(queryClient, room.id, patch) : queryClient.invalidateQueries({ queryKey: ["room", room.id] }));

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <Section title={t("channels.title")} description={canManage ? t("channels.reorder_hint") : undefined}>
        <ChannelTree
          room={room}
          canReorder={canManage}
          canManageRoles={canManageRoles}
          selectedChannelId={selectedCategory ? undefined : selected?.id}
          selectedCategoryId={selectedCategory?.id}
          onSelectChannel={selectChannel}
          onSelectCategory={setCategoryId}
          onDeleteCategory={
            canManage
              ? async (cat) => {
                  try {
                    await api.channels.deleteCategory(room.id, cat.id);
                    await apply(withoutCategory(cat.id));
                  } catch (e) {
                    toastError(e);
                  }
                }
              : undefined
          }
        />
        {canManage && (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await apply(withCategory(await api.channels.createCategory(room.id, { name: newCategory })));
                setNewCategory("");
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder={t("channels.new_category")} aria-label={t("channels.new_category")} maxLength={100} />
            <Button type="submit" variant="ghost" disabled={!newCategory.trim()}>
              +
            </Button>
          </form>
        )}
      </Section>
      {selectedCategory ? (
        <div className="space-y-4" data-testid="category-editor">
          <OverridesEditor key={`category:${selectedCategory.id}`} target={{ type: "category", category: selectedCategory }} room={room} onChanged={apply} />
        </div>
      ) : (
        selected && <ChannelEditor key={selected.id} channel={selected} room={room} canManage={canManage} onChanged={apply} />
      )}
    </div>
  );
}

function ChannelEditor({ channel, room, canManage, onChanged }: { channel: Channel; room: RoomDetail; canManage: boolean; onChanged: (patch?: RoomPatch) => Promise<void> }) {
  const { api, domain } = useNode();
  const t = useT();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic);
  const [categoryId, setCategoryId] = useState(channel.category_id ?? "");
  const [slowmode, setSlowmode] = useState(channel.slowmode_secs);
  const [encrypted, setEncrypted] = useState(channel.encrypted);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmEncryption, setConfirmEncryption] = useState(false);
  const isVoice = channel.kind === "voice";
  // Files channels have no messages; their encryption is chosen at creation and fixed (FILES.md §1).
  const isFiles = channel.kind === "files";
  // The welcome channel (kind `system`): the node refuses renaming, moving, deleting and its other settings; only the
  // topic (and the age gate below) can change.
  const isSystem = channel.kind === "system";
  const filesUsage = useQuery({ queryKey: ["files-usage", domain, channel.id], queryFn: () => api.files.usage(room.id, channel.id), enabled: isFiles && confirmDelete });
  const [keepExternal, setKeepExternal] = useState(false);
  const canManageRoles = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROLES);
  // What the overrides mean for @everyone: the channel list's private mark, spelled out for the admins.
  const privacy = channelPrivacy(room, channel.id);

  const order = useOrderSaver(room.id);

  const save = async () => {
    if (isSystem) {
      try {
        await onChanged(withChannel(await api.channels.update(room.id, channel.id, { topic })));
        useToasts.getState().push({ kind: "info", title: t("channels.saved") });
      } catch (err) {
        toastError(err);
      }
      return;
    }
    // A new category: the channel goes to the end of it and both groups are renumbered (lib/channelOrder.ts), the same
    // plan as a drop on the category's header. The channel's own update rides along with the editor's fields.
    const target = categoryId || null;
    const plan = target !== (channel.category_id ?? null) ? planChannelMove(room, channel.id, target, Number.POSITIVE_INFINITY) : null;
    const own = plan?.ok ? plan.updates.find((u) => u.id === channel.id) : undefined;
    const move = plan ? { category_id: target, ...(own ? { position: own.position } : {}) } : {};
    try {
      await onChanged(withChannel(await api.channels.update(room.id, channel.id, { name, topic, ...move, slowmode_secs: slowmode, encrypted: isVoice || isFiles ? null : encrypted })));
    } catch (err) {
      toastError(err);
      return;
    }
    if (plan?.ok && !(await order.save("channel", { ok: true, updates: plan.updates.filter((u) => u.id !== channel.id) }, { quiet: true }))) return;
    useToasts.getState().push({ kind: "info", title: t("channels.saved") });
  };

  return (
    <div className="space-y-4" data-testid="channel-editor">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isVoice && encrypted !== channel.encrypted && !encrypted) setConfirmEncryption(true);
          else void save();
        }}
      >
        <Section title={`${isVoice ? "🔊" : isFiles ? "📁" : "#"} ${channelName(channel)}`}>
          {privacy && (
            <p className="flex items-center gap-2 text-xs text-fg-1" data-testid="channel-access-line">
              <GroupOffIcon size={16} className="text-fg-2" />
              {t(accessMarkKey(privacy))}
            </p>
          )}
          <Field label={t("common.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage || isSystem} maxLength={100} required />
          </Field>
          {!isVoice && (
            <Field label={t("channel.topic")}>
              <Input value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!canManage} maxLength={1024} />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("channel.category")}>
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!canManage || isSystem}>
                <option value="">{t("common.none")}</option>
                {room.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryName(c)}
                  </option>
                ))}
              </Select>
            </Field>
            {!isVoice && !isFiles && !isSystem && (
              <Field label={t("channels.slowmode")} hint={t("channels.slowmode_hint")}>
                <Input type="number" min={0} max={21600} value={slowmode} onChange={(e) => setSlowmode(Number(e.target.value))} disabled={!canManage} />
              </Field>
            )}
          </div>
          {!isVoice && !isFiles && !isSystem && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} disabled={!canManage} data-testid="encrypted-toggle" />
              <span>
                {t("channels.encrypted")}
                <span className="block text-xs text-fg-2">{t("channels.encrypted_hint")}</span>
              </span>
            </label>
          )}
          {isFiles && (
            <p className="flex items-start gap-2 text-sm text-fg-1" data-testid="files-encryption-fixed">
              <LockMark open={!channel.encrypted} />
              <span>
                {t(channel.encrypted ? "files.fixed_encrypted" : "files.fixed_unencrypted")}
                <span className="block text-xs text-fg-2">{t("files.fixed_hint")}</span>
              </span>
            </p>
          )}
          {canManage && (
            <div className="flex flex-wrap justify-end gap-2">
              {!isSystem && (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  {t("channels.delete")}
                </Button>
              )}
              <Button type="submit">{t("common.save")}</Button>
            </div>
          )}
        </Section>
      </form>
      <AgeGateSection
        key={channel.id}
        scope="channel"
        value={channel.age_gate ?? "none"}
        inherited={room.age_gate === "adults_only"}
        canManage={canManage}
        onSave={async (gate) => {
          await onChanged(withChannel(await api.channels.update(room.id, channel.id, { age_gate: gate })));
        }}
      />
      {isVoice && <VoiceQualitySection channel={channel} room={room} canManage={canManage} onChanged={onChanged} />}
      {isFiles && <StorageSection room={room} channel={channel} />}
      <NoBotsToggles channel={channel} room={room} onChanged={onChanged} />
      <ChannelBotsAllowed channel={channel} room={room} onChanged={onChanged} />
      {channel.encrypted && !isVoice && channel.kind !== "system" && <HistoryPolicySection channel={channel} room={room} canManage={canManage} onChanged={onChanged} />}
      {["text", "announcement", "forum"].includes(channel.kind) && <ThreadSettingsSection channel={channel} room={room} canManage={canManage} onChanged={onChanged} />}
      {canManageRoles && channel.kind !== "system" && <OverridesEditor target={{ type: "channel", channel }} room={room} onChanged={onChanged} />}
      <ConfirmDialog
        open={confirmDelete}
        title={t("channels.delete")}
        text={
          <div className="space-y-2">
            <p>{t("channels.delete_text", { name: channel.name })}</p>
            {isFiles && filesUsage.data && <FilesDeletionFacts info={filesUsage.data} keep={keepExternal} onKeep={setKeepExternal} />}
            {isFiles && filesUsage.isPending && <p className="text-xs text-fg-2">{t("common.loading")}</p>}
          </div>
        }
        confirmWord={channel.name}
        actionLabel={t("room.delete_action")}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const keep = isFiles && keepExternal && !!filesUsage.data && deletionCase(filesUsage.data) === "external_plain";
          await api.channels.delete(room.id, channel.id, { keepExternal: keep });
          setConfirmDelete(false);
          await onChanged(withoutChannel(channel.id));
        }}
      />
      <ConfirmDialog open={confirmEncryption} title={t("channels.encryption_off_title")} text={t("channels.encryption_off_text")} actionLabel={t("channels.encryption_off_action")} onClose={() => setConfirmEncryption(false)} onConfirm={async () => { setConfirmEncryption(false); await save(); }} />
    </div>
  );
}

/**
 * "No bots" for this channel and its category (APPLICATIONS.md §3.5): needs `manage_room` and
 * `manage_channels`. Applied at once; bots lose the channel and their encryption leaves are removed.
 */
function NoBotsToggles({ channel, room, onChanged }: { channel: Channel; room: RoomDetail; onChanged: (patch?: RoomPatch) => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  const { run: act, busy } = useAction();
  const perms = parsePermissions(room.my_permissions);
  const allowed = hasPermission(perms, Permission.MANAGE_ROOM) && hasPermission(perms, Permission.MANAGE_CHANNELS);
  const category = room.categories.find((c) => c.id === channel.category_id);
  const run = (action: () => Promise<RoomPatch>) => act(action, { refresh: onChanged });
  return (
    <Section title={t("apps.no_bots.channel_title")} description={room.no_bots ? t("apps.no_bots.room_wide") : t("apps.no_bots.channel_hint")}>
      <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={channel.no_bots} disabled={!allowed || busy} onChange={(e) => void run(async () => withChannel(await api.channels.update(room.id, channel.id, { no_bots: e.target.checked })))} data-testid="channel-no-bots" />
        {t("apps.no_bots.channel_toggle")}
      </label>
      {category && (
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={category.no_bots} disabled={!allowed || busy} onChange={(e) => void run(async () => withCategory(await api.channels.updateCategory(room.id, category.id, { no_bots: e.target.checked })))} data-testid="category-no-bots" />
          {t("apps.no_bots.category_toggle", { name: categoryName(category) })}
        </label>
      )}
    </Section>
  );
}

type OverrideTarget = { type: "channel"; channel: Channel } | { type: "category"; category: Category };

/**
 * Overrides of a channel or a category (layered, tavrn-protocol permissions.md "Evaluation"): a category's apply to
 * every channel in it, a channel's own win over the category's. Only channel-scoped bits are offered; each shows the
 * value it inherits when left neutral. Channels with own overrides can be reset to their category.
 */
function OverridesEditor({ target, room, onChanged }: { target: OverrideTarget; room: RoomDetail; onChanged: (patch?: RoomPatch) => Promise<void> }) {
  const { api } = useNode();
  const t = useT();
  const targetId = target.type === "channel" ? target.channel.id : target.category.id;
  const overrides = room.overrides.filter((o) => o.target_type === target.type && o.target_id === targetId);
  const everyone = room.roles.find((r) => r.is_everyone);
  const subjects = room.roles.map((r) => ({ type: "role" as const, id: r.id, name: r.name }));
  const [subject, setSubject] = useState(`role:${everyone?.id ?? ""}`);
  const [subjectType, subjectId] = subject.split(":") as ["role" | "member", string];
  const current = overrides.find((o) => o.subject_type === subjectType && o.subject_id === subjectId);
  const [allow, setAllow] = useState(parsePermissions(current?.allow));
  const [deny, setDeny] = useState(parsePermissions(current?.deny));
  const [uploads, setUploads] = useState({ upload_allow: current?.upload_allow ?? [], upload_deny: current?.upload_deny ?? [] });
  const [confirmReset, setConfirmReset] = useState(false);
  const categoryId = target.type === "channel" ? target.channel.category_id : null;
  const category = room.categories.find((c) => c.id === categoryId);
  // What a neutral bit keeps: the roles and, in a channel, its category's overrides.
  const categoryOverrides = target.type === "category" ? null : room.overrides.filter((o) => o.target_type === "category" && o.target_id === categoryId);
  const inherited = (bit: bigint) =>
    inheritedOverrideValue(
      {
        everyone_role_id: everyone?.id ?? "",
        everyone_permissions: everyone?.permissions ?? "0",
        roles: room.roles.filter((r) => !r.is_everyone).map((r) => [r.id, r.permissions] as [string, string]),
        subject: subjectType === "member" ? { type: "member", id: subjectId, roles: [] } : { type: "role", id: subjectId },
        category_overrides: categoryOverrides?.map((o) => ({ subject_type: o.subject_type as "role" | "member", subject_id: o.subject_id, allow: o.allow, deny: o.deny })) ?? null,
      },
      bit,
    );
  const pick = (value: string) => {
    setSubject(value);
    const [ty, id] = value.split(":");
    const o = overrides.find((x) => x.subject_type === ty && x.subject_id === id);
    setAllow(parsePermissions(o?.allow));
    setDeny(parsePermissions(o?.deny));
    setUploads({ upload_allow: o?.upload_allow ?? [], upload_deny: o?.upload_deny ?? [] });
  };
  const save = async () => {
    try {
      const saved = await api.channels.setOverride(room.id, { target_type: target.type, target_id: targetId, subject_type: subjectType, subject_id: subjectId, allow: allow.toString(), deny: deny.toString(), ...uploads });
      await onChanged(withOverrides(target.type, targetId, saved));
      useToasts.getState().push({ kind: "info", title: t("channels.overrides_saved") });
    } catch (e) {
      toastError(e);
    }
  };
  const isEveryone = subjectType === "role" && subjectId === everyone?.id;
  const title = target.type === "channel" ? t("channels.overrides") : t("channels.category_overrides", { name: categoryName(target.category) });
  return (
    <Section title={title} description={target.type === "channel" ? t(category ? "channels.overrides_hint" : "channels.overrides_hint_no_category") : t("channels.category_overrides_hint")}>
      <Field label={t("channels.override_target")}>
        <Select value={subject} onChange={(e) => pick(e.target.value)} aria-label={t("channels.override_target")}>
          {subjects.map((s) => (
            <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      {isEveryone && <p className="text-xs text-fg-2">{t("members.everyone_restricted")}</p>}
      <OverrideTriState allow={allow} deny={deny} onChange={(a, d) => { setAllow(a); setDeny(d); }} restricted={isEveryone ? EVERYONE_RESTRICTED : 0n} inherited={inherited} />
      <UploadOverrides
        room={room}
        subject={{ type: subjectType, id: subjectId }}
        layer={overrides}
        categoryOverrides={categoryOverrides}
        value={uploads}
        onChange={setUploads}
        subjectName={subjects.find((s) => s.type === subjectType && s.id === subjectId)?.name ?? ""}
      />
      <div className="flex flex-wrap justify-end gap-2">
        {target.type === "channel" && category && overrides.length > 0 && (
          <Button variant="ghost" onClick={() => setConfirmReset(true)} data-testid="reset-to-category">
            {t("channels.reset_to_category")}
          </Button>
        )}
        <Button onClick={() => void save()}>{t("channels.save_overrides")}</Button>
      </div>
      <ConfirmDialog
        open={confirmReset}
        title={t("channels.reset_to_category")}
        text={t("channels.reset_to_category_text", { count: overrides.length, name: category ? categoryName(category) : "" })}
        actionLabel={t("channels.reset_to_category_action")}
        onClose={() => setConfirmReset(false)}
        onConfirm={async () => {
          await api.channels.clearOverrides(room.id, overrides);
          setConfirmReset(false);
          setAllow(0n);
          setDeny(0n);
          setUploads({ upload_allow: [], upload_deny: [] });
          await onChanged(withoutOverrides(overrides));
          useToasts.getState().push({ kind: "info", title: t("channels.reset_done") });
        }}
      />
    </Section>
  );
}

type UploadMasks = { upload_allow: string[]; upload_deny: string[] };

/**
 * File types of an override (tavrn-protocol permissions.md "Upload categories"): allow / neutral / deny per category
 * with what a neutral one inherits (the roles' setting and, in a channel, the category's overrides), and the result
 * for the subject with the edits applied: the category's layer, then the channel's.
 */
function UploadOverrides({ room, subject, layer, categoryOverrides, value, onChange, subjectName }: { room: RoomDetail; subject: { type: "role" | "member"; id: string }; layer: UploadOverrideInput[]; categoryOverrides: UploadOverrideInput[] | null; value: UploadMasks; onChange: (next: UploadMasks) => void; subjectName: string }) {
  const t = useT();
  const everyone = room.roles.find((r) => r.is_everyone);
  const role = subject.type === "role" && subject.id !== everyone?.id ? room.roles.find((r) => r.id === subject.id) : undefined;
  const input: UploadSubject = {
    everyoneId: everyone?.id ?? "",
    everyone: everyone?.allowed_upload_categories,
    roles: role ? [{ id: role.id, position: role.position, categories: role.allowed_upload_categories }] : [],
    memberId: subject.type === "member" ? subject.id : undefined,
    privileged: hasPermission(parsePermissions(everyone?.permissions) | parsePermissions(role?.permissions), Permission.ADMINISTRATOR),
  };
  const own = (o: UploadOverrideInput) => o.subject_type === subject.type && o.subject_id === subject.id;
  const edited = [...layer.filter((o) => !own(o)), { subject_type: subject.type, subject_id: subject.id, ...value }];
  const effective = effectiveUploads(input, categoryOverrides ? [categoryOverrides, edited] : [edited]);
  const names = effective.map((c) => t(`upload.category.${c}`)).join(", ");
  return (
    <fieldset data-testid="upload-overrides">
      <legend className="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{t("channels.upload_title")}</legend>
      <ul className="mt-1 divide-y divide-line">
        {UPLOAD_CATEGORIES.map((c) => (
          <TriStateRow
            key={c}
            label={t(`upload.category.${c}`)}
            state={overrideUploadState(value, c)}
            onChange={(state) => onChange(setOverrideUpload(value, c, state))}
            inherited={inheritedUpload(input, categoryOverrides, c)}
            inheritedTestId={`inherited-upload-${c}`}
            rowProps={{ "data-upload": c }}
          />
        ))}
      </ul>
      <p className="mt-2 text-sm text-fg-1" data-testid="upload-effective" aria-live="polite">
        {effective.length ? t("channels.upload_effective", { name: subjectName, categories: names }) : t("channels.upload_effective_none", { name: subjectName })}
      </p>
      <p className="mt-1 text-xs text-fg-2">{t("upload.executables_hint")}</p>
    </fieldset>
  );
}
