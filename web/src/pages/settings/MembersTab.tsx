// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type Member, type RoomDetail } from "@tavrn/sdk";
import { useNode } from "../../components/NodeScope";
import { intlLocale, useT } from "../../i18n";
import { useAuth } from "../../stores/auth";
import { describeError } from "../../stores/toasts";
import { useAction } from "../../hooks/useAction";
import { Avatar, Button, Dialog, Field, Input } from "../../components/ui";
import { Section } from "./common";

export function useMembers(roomId: string) {
  const { api } = useNode();
  return useQuery({ queryKey: ["members", roomId], queryFn: () => api.members.list(roomId, { limit: 500 }) });
}

export function MembersTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const members = useMembers(room.id);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Member | null>(null);
  if (members.isPending) return <p className="text-sm text-fg-2">{t("members.loading")}</p>;
  if (members.isError) return <p className="text-sm text-danger">{describeError(members.error)}</p>;
  const list = members.data.filter((m) => `${m.user.display_name} ${m.user.address} ${m.nickname ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Section title={t("members.count", { count: members.data.length })}>
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("common.search")} aria-label={t("member.search")} />
      <ul className="divide-y divide-line" data-testid="settings-member-list">
        {list.map((m) => (
          <li key={m.user.id} className="flex min-h-12 items-center gap-3 py-1">
            <Avatar name={m.nickname ?? m.user.display_name} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {m.nickname ?? m.user.display_name} <span className="text-xs text-fg-2">{m.user.address}</span>
                {m.user.id === room.owner_id && <span className="ml-1 text-xs text-accent">{t("member.owner")}</span>}
                {m.timeout_until && <span className="ml-1 text-xs text-warn">{t("member.timeout")}</span>}
              </p>
              <p className="truncate text-xs text-fg-2">{m.roles.map((id) => room.roles.find((r) => r.id === id)?.name ?? id).join(", ") || t("member.no_roles")}</p>
            </div>
            <Button variant="ghost" onClick={() => setSelected(m)} aria-label={t("member.edit", { name: m.user.display_name })}>
              {t("common.edit")}
            </Button>
          </li>
        ))}
      </ul>
      {selected && <MemberDialog member={selected} room={room} onClose={() => setSelected(null)} />}
    </Section>
  );
}

function MemberDialog({ member, room, onClose }: { member: Member; room: RoomDetail; onClose: () => void }) {
  const { api } = useNode();
  const t = useT();
  const me = useAuth((s) => s.user);
  const queryClient = useQueryClient();
  const perms = parsePermissions(room.my_permissions);
  const isSelf = member.user.id === me?.id;
  const isOwner = member.user.id === room.owner_id;
  const myTop = room.is_owner ? Number.MAX_SAFE_INTEGER : Math.max(0, ...room.roles.filter((r) => room.my_roles.includes(r.id)).map((r) => r.position));
  const [roles, setRoles] = useState<string[]>(member.roles);
  const [nickname, setNickname] = useState(member.nickname ?? "");
  const [action, setAction] = useState<"kick" | "ban" | "timeout" | null>(null);
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(10);
  const mutation = useAction({
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: ["members", room.id] });
      await queryClient.invalidateQueries({ queryKey: ["room", room.id] });
    },
  });
  const run = async (fn: () => Promise<unknown>, done: string) => {
    if (await mutation.run(fn, { done })) onClose();
  };
  const canRoles = hasPermission(perms, Permission.MANAGE_ROLES);
  const canNick = isSelf ? hasPermission(perms, Permission.CHANGE_NICKNAME) : hasPermission(perms, Permission.MANAGE_NICKNAMES);
  const canModerate = !isOwner && !isSelf;

  return (
    <Dialog title={member.user.display_name} open onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-xs text-fg-2">
          {member.user.address} · {t("member.joined", { date: new Date(member.joined_at).toLocaleDateString(intlLocale()) })}
        </p>
        <Field label={t("member.nickname")}>
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} disabled={!canNick} maxLength={32} />
        </Field>
        <fieldset disabled={!canRoles}>
          <legend className="text-fg-1">{t("member.roles")}</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {room.roles.filter((r) => !r.is_everyone).map((r) => (
              <label key={r.id} className={`flex min-h-9 items-center gap-2 ${r.position >= myTop ? "opacity-40" : ""}`}>
                <input type="checkbox" className="h-4 w-4" checked={roles.includes(r.id)} disabled={r.position >= myTop} onChange={(e) => setRoles(e.target.checked ? [...roles, r.id] : roles.filter((x) => x !== r.id))} />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap justify-end gap-2">
          {(canRoles || canNick) && (
            <Button disabled={mutation.busy} onClick={() => void run(() => api.members.update(room.id, member.user.id, { ...(canNick ? { nickname: nickname.trim() || null } : {}), ...(canRoles ? { roles } : {}) }), t("member.saved"))}>
              {t("common.save")}
            </Button>
          )}
        </div>
        {canModerate && (
          <div className="border-t border-line pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-2">{t("member.moderation")}</p>
            <div className="flex flex-wrap gap-2">
              {hasPermission(perms, Permission.MODERATE_MEMBERS) && (
                <Button variant="ghost" onClick={() => setAction("timeout")}>
                  {member.timeout_until ? t("member.timeout_clear") : t("member.timeout_set")}
                </Button>
              )}
              {hasPermission(perms, Permission.KICK_MEMBERS) && (
                <Button variant="ghost" onClick={() => setAction("kick")}>
                  {t("member.kick")}
                </Button>
              )}
              {hasPermission(perms, Permission.BAN_MEMBERS) && (
                <Button variant="danger" onClick={() => setAction("ban")}>
                  {t("member.ban")}
                </Button>
              )}
            </div>
          </div>
        )}
        {action && (
          <div className="space-y-2 rounded-md border border-line bg-bg-0 p-3" data-testid="moderation-form">
            {action === "timeout" && !member.timeout_until && (
              <Field label={t("member.duration")}>
                <Input type="number" min={1} max={40320} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
              </Field>
            )}
            <Field label={t("member.reason")}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAction(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={mutation.busy}
                onClick={() =>
                  void run(
                    () =>
                      action === "kick"
                        ? api.members.kick(room.id, member.user.id)
                        : action === "ban"
                          ? api.members.ban(room.id, { subject: member.user.address, reason })
                          : api.members.timeout(room.id, member.user.id, { minutes: member.timeout_until ? 0 : minutes, reason }),
                    action === "kick" ? t("member.kicked") : action === "ban" ? t("member.banned") : t("member.timeout_done"),
                  )
                }
              >
                {action === "kick" ? t("member.kick") : action === "ban" ? t("member.ban") : member.timeout_until ? t("member.timeout_clear") : t("member.timeout_set")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function BansTab({ room }: { room: RoomDetail }) {
  const { api } = useNode();
  const t = useT();
  const queryClient = useQueryClient();
  const bans = useQuery({ queryKey: ["bans", room.id], queryFn: () => api.members.bans(room.id) });
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const { run, busy } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["bans", room.id] }) });
  return (
    <Section title={t("bans.title")} description={t("bans.hint")}>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.members.ban(room.id, { subject, reason });
            setSubject("");
            setReason("");
          });
        }}
      >
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("bans.placeholder")} aria-label={t("bans.subject")} className="flex-1" required />
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("bans.reason_placeholder")} aria-label={t("bans.reason")} className="flex-1" />
        <Button type="submit" variant="danger" disabled={busy}>
          {t("bans.ban")}
        </Button>
      </form>
      {bans.isError && <p className="text-sm text-danger">{describeError(bans.error)}</p>}
      <ul className="divide-y divide-line" data-testid="ban-list">
        {bans.data?.map((b) => (
          <li key={b.id} className="flex min-h-10 items-center gap-2 text-sm">
            <span className="flex-1 truncate">
              {b.subject} {b.reason && <span className="text-fg-2">· {b.reason}</span>}
            </span>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.members.unban(room.id, b.subject))}>
              {t("bans.lift")}
            </Button>
          </li>
        ))}
        {bans.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("bans.none")}</li>}
      </ul>
    </Section>
  );
}
