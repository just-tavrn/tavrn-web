// SPDX-License-Identifier: Apache-2.0
/**
 * The account bar at the bottom of the sidebar: the avatar with the account menu (presence, status, node
 * administration for node admins, legal pages, sign out), the own name with the connection state below it, the
 * notification bell and the user settings. Phones show the bell in the header instead (AppShell `headerExtra`), so
 * exactly one bell is visible per layout.
 */
import { useNavigate } from "react-router";
import { useAuth } from "../stores/auth";
import { useRealtimeState } from "../hooks/useRealtime";
import { useT } from "../i18n";
import { useShell } from "../components/AppShell";
import { PresenceMenu } from "../components/PresenceMenu";
import { NotificationBell } from "../components/NotificationCenter";
import { GearIcon } from "../components/icons";

function StatusDot() {
  const t = useT();
  const status = useRealtimeState((s) => s.status);
  const color = status === "ready" ? "bg-brand-mint" : status === "closed" ? "bg-danger" : "bg-warn";
  const label = t(`shell.status.${status}`);
  return (
    <span className="flex items-center gap-1.5 text-xs text-fg-2" title={label} data-testid="ws-status" data-status={status}>
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function AccountBar() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const remoteHome = useAuth((s) => !!s.home);
  const navigate = useNavigate();
  const { closeNav } = useShell();
  return (
    // `relative`: the account menu is positioned against the whole bar, so it never grows wider than the sidebar (tavrn-web#115).
    <div className="relative flex items-center gap-1 border-t border-line bg-bg-0 p-2" data-testid="account-bar">
      <PresenceMenu />
      <div className="min-w-0 flex-1 pl-1">
        <p className="truncate text-sm font-medium" data-testid="me-name" title={user?.display_name}>
          {user?.display_name}
        </p>
        {/* Signed in with an account of another node: its full address, domain included (design note 9d). */}
        {remoteHome && (
          <p className="truncate text-[11px] text-fg-2" data-testid="me-address" title={t("auth.remote_home_hint", { domain: user?.domain ?? "" })}>
            {user?.address}
          </p>
        )}
        <StatusDot />
      </div>
      <NotificationBell className="hidden md:inline-flex" />
      <button type="button" aria-label={t("user.settings")} title={t("user.settings")} className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" onClick={() => { closeNav(); navigate("/settings"); }}>
        <GearIcon size={22} />
      </button>
    </div>
  );
}
