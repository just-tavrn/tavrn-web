// SPDX-License-Identifier: Apache-2.0
/**
 * The members of a role, opened from a role pill in a message (`@Raid Leads`): avatar and name of each member the
 * viewer's member list contains (the node decides what the viewer sees of it), at most {@link ROLE_POPOVER_MAX}
 * with "and N more"; a member opens their profile card. A floating dialog like the profile card (a bottom sheet on
 * phones): it takes the focus, keeps Tab inside, closes with Escape or a click outside and gives the focus back.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Member, Role } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useFloating, type AnchorRect } from "../lib/position";
import { useFocusTrap } from "../lib/focusTrap";
import { memberName } from "../lib/memberGroups";
import { UserAvatar } from "../components/Avatar";

export const ROLE_POPOVER_MAX = 25;

/** The members holding `role`, by name (stable order for the list). */
export function roleMembers(role: Pick<Role, "id">, members: readonly Member[]): Member[] {
  return members.filter((m) => m.roles.includes(role.id)).sort((a, b) => memberName(a).localeCompare(memberName(b)));
}

export function RolePopover({ name, roles, members, anchor, onPick, onClose }: { name: string; roles: readonly Role[]; members: readonly Member[] | undefined; anchor: AnchorRect | null; onPick: (address: string) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const role = roles.find((r) => !r.is_everyone && r.name.toLowerCase() === name.toLowerCase());
  const list = useMemo(() => (role && members ? roleMembers(role, members) : []), [role, members]);
  const shown = list.slice(0, ROLE_POPOVER_MAX);
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useFocusTrap(ref, true, { initial: () => ref.current });
  const floating = useFloating(ref, narrow ? null : anchor, { prefer: "right" }, [list.length]);
  const style: CSSProperties = narrow || !anchor ? {} : { ...floating, width: 280 };
  const title = t("roles.popover_title", { role: role?.name ?? name });
  return createPortal(
    <div className={`fixed inset-0 z-50 ${!narrow && !anchor ? "flex items-center justify-center p-4" : ""}`} onMouseDown={onClose} data-testid="role-popover-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={narrow ? "fixed inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-xl border border-line bg-bg-1 p-3 shadow-xl outline-none" : "overflow-y-auto rounded-xl border border-line bg-bg-1 p-3 shadow-xl outline-none"}
        style={style}
        data-testid="role-popover"
      >
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg-0">
          {role?.color && <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ background: role.color }} />}
          <span className="min-w-0 truncate">{title}</span>
          <span className="ml-auto shrink-0 text-xs font-normal text-fg-2">{list.length}</span>
        </h2>
        {!role || !members ? (
          <p className="text-sm text-fg-2">{t(role ? "common.loading" : "roles.popover_unknown")}</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-fg-2">{t("roles.popover_empty")}</p>
        ) : (
          <ul className="space-y-0.5" data-testid="role-popover-members">
            {shown.map((m) => (
              <li key={m.user.address}>
                <button type="button" className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-fg-0 hover:bg-bg-3" onClick={() => onPick(m.user.address)} aria-label={t("profile.open", { name: memberName(m) })} data-address={m.user.address}>
                  <UserAvatar user={m.user} size={24} />
                  <span className="min-w-0 truncate">{memberName(m)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.length > shown.length && (
          <p className="mt-2 text-xs text-fg-2" data-testid="role-popover-more">
            {t("roles.popover_more", { count: list.length - shown.length })}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
