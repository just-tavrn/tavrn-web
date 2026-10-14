// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point of the role preview (docs/CLIENT.md "View the room as a role"): Room settings → Roles → "View room as
 * this role", for `@everyone` and the roles the viewer may manage. The dialog picks further roles to combine and the
 * simulated join date (now by default: the start of the encrypted history window), then opens the room as them.
 */
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import type { Role, RoomDetail } from "@tavrn/sdk";
import { canManageRole, sortRoles, topPosition } from "../../lib/hierarchy";
import { useNode } from "../../components/NodeScope";
import { Button, Dialog, Field, Input } from "../../components/ui";
import { useT } from "../../i18n";
import { useRolePreview } from "../../stores/rolePreview";

/** `YYYY-MM-DDTHH:mm` in local time, the value format of `<input type="datetime-local">`. */
export function localDateTimeValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The roles the viewer may preview: the ones they may manage (below their highest role; every role for the owner). */
export function previewableRoles(room: Pick<RoomDetail, "roles" | "my_roles" | "is_owner">): Role[] {
  const myTop = topPosition(room.roles, room.my_roles, room.is_owner);
  return sortRoles(room.roles.filter((r) => !r.is_everyone && (room.is_owner || canManageRole(r.position, myTop))));
}

export function ViewAsRole({ room, role }: { room: RoomDetail; role: Role }) {
  const t = useT();
  const navigate = useNavigate();
  const { roomPath } = useNode();
  const start = useRolePreview((s) => s.start);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [joined, setJoined] = useState("");
  const listId = useId();
  const roles = previewableRoles(room);
  if (!role.is_everyone && !roles.some((r) => r.id === role.id)) return null;
  const everyone = room.roles.find((r) => r.is_everyone);
  const openDialog = () => {
    setChosen(role.is_everyone ? [] : [role.id]);
    setJoined(localDateTimeValue(Date.now()));
    setOpen(true);
  };
  const begin = () => {
    const at = Date.parse(joined);
    const roleIds = roles.filter((r) => chosen.includes(r.id)).map((r) => r.id);
    const names = roles.filter((r) => roleIds.includes(r.id)).map((r) => r.name);
    start({ roomId: room.id, roleIds, joinedAt: Number.isFinite(at) ? at : Date.now(), label: names.length ? names.join(", ") : (everyone?.name ?? "@everyone") });
    setOpen(false);
    navigate(roomPath(room.id));
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg-0 px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-fg-1">{t("roleview.entry_hint")}</p>
        <Button variant="ghost" onClick={openDialog} data-testid="view-as-role">
          👁 {t("roleview.start")}
        </Button>
      </div>
      <Dialog title={t("roleview.dialog_title")} open={open} onClose={() => setOpen(false)}>
        <div className="space-y-4" data-testid="view-as-dialog">
          <p className="text-sm text-fg-1">{t("roleview.dialog_hint")}</p>
          {roles.length > 0 && (
            <fieldset aria-describedby={listId}>
              <legend className="mb-1 text-sm text-fg-1">{t("roleview.roles")}</legend>
              <p id={listId} className="mb-2 text-xs text-fg-2">
                {t("roleview.roles_hint", { everyone: everyone?.name ?? "@everyone" })}
              </p>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {roles.map((r) => (
                  <label key={r.id} className="flex min-h-9 items-center gap-2 text-sm text-fg-0">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={chosen.includes(r.id)}
                      onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.id] : c.filter((x) => x !== r.id)))}
                      data-testid="view-as-role-option"
                      data-role={r.name}
                    />
                    <span className="truncate">{r.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field label={t("roleview.joined_at")} hint={t("roleview.joined_at_hint")}>
            <Input type="datetime-local" value={joined} onChange={(e) => setJoined(e.target.value)} data-testid="view-as-joined" />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={begin} data-testid="view-as-start">
              {t("roleview.open")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
