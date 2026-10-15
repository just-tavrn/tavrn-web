// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Navigate, useNavigate, useParams } from "react-router";
import type { AdminUser, AuditEntry, DirectoryReport, FederationPeer, ReportSummary } from "@tavrn/sdk";
import { api } from "../lib/api";
import { intlLocale, useT } from "../i18n";
import { useAuth } from "../stores/auth";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { useAction } from "../hooks/useAction";
import { formatSize } from "../components/AttachmentView";
import { Button, Field, Input } from "../components/ui";
import { ConfirmDialog, Section } from "./settings/common";
import { EntitlementsTab } from "./admin/EntitlementsTab";
import { ApiTokensTab } from "./admin/ApiTokensTab";
import { ApplicationsTab } from "./admin/ApplicationsTab";
import { SsoGroupMapTab } from "./admin/SsoGroupMapTab";
import { LegalDocumentsTab } from "./admin/LegalDocumentsTab";
import { NoticesTab } from "./admin/NoticesTab";
import { DeletionsSection, UserDataActions } from "./admin/AccountRequests";
import { ReportsInbox } from "../moderation/ReportsInbox";
import { badgeText, useOpenAdminReports } from "../moderation/hooks";
import { webOrigin } from "../platform";
import { nodeInfoQuery } from "../lib/queries";

const TABS = ["overview", "users", "invites", "bans", "reports", "entitlements", "tokens", "applications", "sso", "federation", "legal", "notices", "audit"] as const;
type Tab = (typeof TABS)[number];
/** Tabs whose labels live outside `admin.tab.*`. */
const TAB_LABEL: Partial<Record<Tab, string>> = { applications: "admin.apps.tab", sso: "admin.sso.tab", legal: "admin.legal.tab", notices: "admin.notices.tab", reports: "reports.tab" };

export function AdminPage() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const { tab = "overview" } = useParams();
  const navigate = useNavigate();
  // The SSO tab only exists when the node offers OIDC logins (capability `sso.oidc`, APPLICATIONS.md §8).
  const node = useQuery({ ...nodeInfoQuery(null), enabled: !!user?.is_node_admin });
  const sso = !!node.data?.capabilities?.includes("sso.oidc");
  // Reports (MODERATION.md) on nodes that announce them; the tab shows the open count.
  const reports = !!node.data?.capabilities?.includes("reports.v1");
  // Forwarding reports about users of other nodes to their home node (MODERATION.md §1.6).
  const forwardFrom = node.data?.capabilities?.includes("reports.v2") ? (user?.domain ?? null) : null;
  const tabs = TABS.filter((x) => (x !== "sso" || sso) && (x !== "reports" || reports));
  const openReports = badgeText(useOpenAdminReports(api, !!user?.is_node_admin && reports));
  if (!user?.is_node_admin) return <Navigate to="/" replace />;
  if (!TABS.includes(tab as Tab)) return <Navigate to="/admin/overview" replace />;
  if (tab === "sso" && node.isSuccess && !sso) return <Navigate to="/admin/overview" replace />;
  if (tab === "reports" && node.isSuccess && !reports) return <Navigate to="/admin/overview" replace />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 select-none items-center gap-2 border-b border-line px-4">
        <button type="button" onClick={() => navigate("/")} className="min-h-10 min-w-10 rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" aria-label={t("shell.home")}>
          ←
        </button>
        <h1 className="truncate text-sm font-semibold">{t("admin.title")}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label={t("settings.sections")} className="flex shrink-0 select-none gap-1 overflow-x-auto border-b border-line p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
          {tabs.map((x) => (
            <NavLink key={x} to={`/admin/${x}`} data-testid={`admin-tab-${x}`} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-2 text-sm ${isActive ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3/60 hover:text-fg-0"}`}>
              {t(TAB_LABEL[x] ?? `admin.tab.${x}`)}
              {x === "reports" && openReports && (
                <span className="ml-2 rounded-full bg-danger-solid px-1.5 text-[11px] font-semibold text-white" data-testid="admin-reports-badge">
                  {openReports}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {/* `relative`: the scroll container is the containing block of positioned helpers inside a tab (`sr-only`
            legends); otherwise they are placed against the app shell, which grows and scrolls (tavrn-web#116). */}
        <div className="relative min-h-0 flex-1 overflow-y-auto p-4" tabIndex={0}>
          {tab === "overview" && <OverviewTab />}
          {tab === "users" && <UsersTab />}
          {tab === "invites" && <InvitesTab />}
          {tab === "bans" && <BansTab />}
          {tab === "reports" && <ReportsInbox client={api} mode={{ kind: "admin", forwardFrom }} meId={user?.id} />}
          {tab === "entitlements" && <EntitlementsTab />}
          {tab === "tokens" && <ApiTokensTab />}
          {tab === "applications" && <ApplicationsTab />}
          {tab === "sso" && sso && <SsoGroupMapTab />}
          {tab === "federation" && <FederationTab />}
          {tab === "legal" && <LegalDocumentsTab />}
          {tab === "notices" && <NoticesTab />}
          {tab === "audit" && <AuditTab />}
        </div>
      </div>
    </div>
  );
}

function OverviewTab() {
  const t = useT();
  const q = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api.admin.overview() });
  if (q.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (q.isError) return <p className="text-sm text-danger">{describeError(q.error)}</p>;
  const o = q.data;
  const stats = [
    [t("admin.stat.users"), o.users],
    [t("admin.stat.rooms"), o.rooms],
    [t("admin.stat.messages"), o.messages],
    [t("admin.stat.storage"), formatSize(o.blob_bytes)],
  ] as const;
  const config = [
    ["TAVRN_DOMAIN", o.domain],
    ["version", o.version],
    ["TAVRN_REGISTRATION", o.registration],
    ["TAVRN_EMAIL", o.email],
    ["TAVRN_CAPTCHA_PROVIDER", o.captcha_provider],
    ["TAVRN_GIF_PROVIDER", o.gif_provider],
    ["TAVRN_ROOM_CREATION", o.room_creation],
    ["TAVRN_UPLOAD_MAX_BYTES", formatSize(o.upload_max_bytes)],
    ["SMTP", o.smtp_enabled ? t("common.yes") : t("common.no")],
    ["capabilities", o.capabilities.join(", ")],
  ] as const;
  return (
    <div className="space-y-4">
      <Section title={t("admin.overview")}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="admin-stats">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded-md border border-line bg-bg-0 p-3">
              <dt className="text-xs text-fg-2">{label}</dt>
              <dd className="text-lg font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title={t("admin.config")} description={t("admin.config_hint")}>
        <dl className="divide-y divide-line text-sm">
          {config.map(([k, v]) => (
            <div key={k} className="flex min-h-9 items-center justify-between gap-4">
              <dt className="font-mono text-xs text-fg-2">{k}</dt>
              <dd className="truncate">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

function UsersTab() {
  const t = useT();
  const me = useAuth((s) => s.user);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [grant, setGrant] = useState<Record<string, string>>({});
  const [purge, setPurge] = useState<{ user: AdminUser; count: number; token: string } | null>(null);
  const [resetFactor, setResetFactor] = useState<AdminUser | null>(null);
  const [resetAudit, setResetAudit] = useState<Record<string, AuditEntry | null>>({});
  const users = useQuery({ queryKey: ["admin", "users", search], queryFn: () => api.admin.users({ q: search, limit: 100 }) });
  const { run, busy } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }) });
  const update = (id: string, body: Parameters<typeof api.admin.updateUser>[1]) => run(() => api.admin.updateUser(id, body));
  return (
    <Section title={t("admin.users")}>
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("common.search")} aria-label={t("admin.users_search")} />
      {users.isError && <p className="text-sm text-danger">{describeError(users.error)}</p>}
      <ul className="divide-y divide-line" data-testid="admin-user-list">
        {users.data?.map((u) => (
          <li key={u.id} className="space-y-2 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{u.display_name}</span>
              <span className="text-xs text-fg-2">{u.address}</span>
              {u.email && <span className="text-xs text-fg-2">· {u.email}{u.email_verified ? " ✓" : ""}</span>}
              {u.is_node_admin && <span className="rounded bg-accent-soft px-1.5 text-xs text-accent">{t("admin.user_admin")}</span>}
              {u.disabled && !u.deleted && <span className="rounded bg-danger/15 px-1.5 text-xs text-danger">{t("admin.user_disabled")}</span>}
              {u.deleted && <span className="rounded bg-danger/15 px-1.5 text-xs text-danger" data-testid="admin-user-deleted">{t("admin.data.deleted")}</span>}
              {u.room_creation_grant !== null && u.room_creation_grant !== undefined && <span className="text-xs text-fg-2">· {t("admin.user_grant", { count: u.room_creation_grant })}</span>}
            </div>
            {u.id !== me?.id && u.deleted && (
              <div className="flex flex-wrap items-center gap-2">
                <UserDataActions user={u} />
              </div>
            )}
            {u.id !== me?.id && !u.deleted && (
              <div className="flex flex-wrap items-center gap-2">
                <UserDataActions user={u} />
                <Button variant="ghost" disabled={busy} onClick={() => void update(u.id, { disabled: !u.disabled })}>
                  {u.disabled ? t("admin.enable") : t("admin.disable")}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void update(u.id, { node_admin: !u.is_node_admin })}>
                  {u.is_node_admin ? t("admin.remove_admin") : t("admin.make_admin")}
                </Button>
                <label className="flex items-center gap-1 text-xs text-fg-2">
                  {t("admin.grant")}
                  <input type="number" min={0} max={1000} aria-label={`${t("admin.grant")} ${u.username}`} value={grant[u.id] ?? String(u.room_creation_grant ?? 0)} onChange={(e) => setGrant({ ...grant, [u.id]: e.target.value })} className="w-16 rounded-md border border-line-strong bg-bg-0 px-2 py-1 text-sm text-fg-0" />
                  <Button variant="ghost" disabled={busy} onClick={() => void update(u.id, { room_creation_grant: Number(grant[u.id] ?? u.room_creation_grant ?? 0) })}>
                    {t("admin.grant_set")}
                  </Button>
                </label>
                <Button variant="ghost" onClick={() => setResetFactor(u)}>
                  {t("admin.reset_2fa")}
                </Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    try {
                      const preview = await api.admin.purgeUser(u.id, {});
                      setPurge({ user: u, count: preview.messages, token: preview.confirm_token ?? "" });
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                >
                  {t("admin.purge_user")}
                </Button>
              </div>
            )}
            {u.id in resetAudit && (
              <p className="rounded-md border border-line bg-bg-0 px-2 py-1 text-xs text-fg-1" data-testid="reset-2fa-audit">
                {resetAudit[u.id]
                  ? t("admin.reset_2fa_audit", { action: resetAudit[u.id]!.action, target: resetAudit[u.id]!.target, date: new Date(resetAudit[u.id]!.created_at).toLocaleString(intlLocale()) })
                  : t("admin.reset_2fa_done")}
              </p>
            )}
          </li>
        ))}
      </ul>
      <DeletionsSection />
      {resetFactor && (
        <ConfirmDialog
          open
          title={t("admin.reset_2fa_title", { name: resetFactor.address })}
          text={t("admin.reset_2fa_text", { name: resetFactor.address })}
          confirmWord={resetFactor.username}
          actionLabel={t("admin.reset_2fa")}
          onClose={() => setResetFactor(null)}
          onConfirm={async () => {
            const target = resetFactor;
            await api.admin.resetSecondFactor(target.id);
            setResetFactor(null);
            useToasts.getState().push({ kind: "info", title: t("admin.reset_2fa_done") });
            const entry = (await api.admin.auditLog({ limit: 20 }).catch(() => [] as AuditEntry[])).find((e) => e.action === "admin.second_factor_reset" && e.target === target.address) ?? null;
            setResetAudit((m) => ({ ...m, [target.id]: entry }));
            await queryClient.invalidateQueries({ queryKey: ["admin", "audit"] });
          }}
        />
      )}
      {purge && (
        <ConfirmDialog
          open
          title={t("admin.purge_user_title", { name: purge.user.username })}
          text={t("admin.purge_user_text", { count: purge.count, name: purge.user.username })}
          confirmWord={purge.user.username}
          actionLabel={t("moderation.confirm_action")}
          onClose={() => setPurge(null)}
          onConfirm={async () => {
            const done = await api.admin.purgeUser(purge.user.id, { confirm_token: purge.token });
            setPurge(null);
            useToasts.getState().push({ kind: "info", title: t("moderation.deleted", { count: done.messages }) });
          }}
        />
      )}
    </Section>
  );
}

function InvitesTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const invites = useQuery({ queryKey: ["admin", "invites"], queryFn: () => api.admin.invites() });
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [hours, setHours] = useState(168);
  const { run, busy } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["admin", "invites"] }) });
  return (
    <Section title={t("admin.invites")} description={t("admin.invites_hint")}>
      <form
        className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.admin.createInvite({ note, max_uses: maxUses, expires_hours: hours });
            setNote("");
          });
        }}
      >
        <Field label={t("admin.invite_note")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <Field label={t("admin.invite_max_uses")}>
          <Input type="number" min={0} max={10000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} />
        </Field>
        <Field label={t("admin.invite_expires")}>
          <Input type="number" min={0} max={8760} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </Field>
        <Button type="submit" disabled={busy}>
          {t("admin.invite_create")}
        </Button>
      </form>
      <ul className="divide-y divide-line text-sm" data-testid="account-invite-list">
        {invites.data?.map((i) => (
          <li key={i.code} className="flex flex-wrap items-center gap-2 py-2">
            <code className="rounded bg-bg-0 px-1.5 py-0.5 text-xs">{`${webOrigin()}/login?invite=${i.code}`}</code>
            {i.note && <span className="text-fg-1">{i.note}</span>}
            <span className="text-xs text-fg-2">{t("admin.invite_uses", { uses: i.uses, max: i.max_uses === 0 ? t("admin.invite_unlimited") : i.max_uses })}</span>
            <span className="flex-1" />
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(`${webOrigin()}/login?invite=${i.code}`)}>
              {t("common.copy")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.admin.deleteInvite(i.code))}>
              {t("common.delete")}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function BansTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const bans = useQuery({ queryKey: ["admin", "bans"], queryFn: () => api.admin.bans() });
  const [subject, setSubject] = useState("");
  const [reason, setReason] = useState("");
  const { run, busy } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["admin", "bans"] }) });
  return (
    <Section title={t("admin.bans")} description={t("admin.bans_hint")}>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.admin.ban({ subject, reason });
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
      <ul className="divide-y divide-line" data-testid="admin-ban-list">
        {bans.data?.map((b) => (
          <li key={b.id} className="flex min-h-10 items-center gap-2 text-sm">
            <span className="flex-1 truncate">
              {b.subject} {b.reason && <span className="text-fg-2">· {b.reason}</span>}
            </span>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.admin.unban(b.subject))}>
              {t("bans.lift")}
            </Button>
          </li>
        ))}
        {bans.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("bans.none")}</li>}
      </ul>
    </Section>
  );
}

function AuditTab() {
  const t = useT();
  const [before, setBefore] = useState<string | undefined>();
  const entries = useQuery({ queryKey: ["admin", "audit", before], queryFn: () => api.admin.auditLog({ limit: 50, before }) });
  return (
    <Section title={t("admin.audit")}>
      <ul className="divide-y divide-line text-sm" data-testid="admin-audit-list">
        {entries.data?.map((e) => (
          <li key={e.id} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-fg-1">{e.action}</span>
              {e.target && <span className="text-fg-2">→ {e.target}</span>}
              <time className="ml-auto text-xs text-fg-2" dateTime={e.created_at}>
                {new Date(e.created_at).toLocaleString(intlLocale())}
              </time>
            </div>
            {e.meta && Object.keys(e.meta).length > 0 && <p className="truncate text-xs text-fg-2">{JSON.stringify(e.meta)}</p>}
          </li>
        ))}
        {entries.data?.length === 0 && <li className="py-2 text-fg-2">{t("audit.none")}</li>}
      </ul>
      {entries.data && entries.data.length === 50 && (
        <Button variant="ghost" onClick={() => setBefore(entries.data.at(-1)?.id)}>
          {t("audit.older")}
        </Button>
      )}
    </Section>
  );
}

const RESULT_STYLE: Record<string, string> = {
  pass: "bg-accent-soft text-accent",
  warn: "bg-warn/15 text-warn",
  fail: "bg-danger/15 text-danger",
  skip: "bg-bg-3 text-fg-2",
  unknown: "bg-bg-3 text-fg-2",
};

function ResultBadge({ result, label }: { result: string; label: string }) {
  return <span className={`rounded px-1.5 text-xs font-medium ${RESULT_STYLE[result] ?? RESULT_STYLE.unknown}`}>{label}</span>;
}

/**
 * Peers with their conformance record (FEDERATION.md §9): result of the last check, failure and
 * violation counts, block state; run a check now, block or unblock a node.
 */
function FederationTab() {
  const t = useT();
  const queryClient = useQueryClient();
  const peers = useQuery({ queryKey: ["admin", "federation"], queryFn: () => api.admin.federationPeers({ limit: 200 }) });
  const [domain, setDomain] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { run: act, busy } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["admin", "federation"] }) });
  const runCheck = async (target: string) => {
    setRunning(target);
    await act(async () => {
      await api.admin.checkPeer(target);
      setOpen((o) => ({ ...o, [target]: true }));
    });
    setRunning(null);
  };
  return (
    <Section title={t("admin.federation")} description={t("admin.federation_hint")}>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const target = domain.trim().toLowerCase();
          if (target) void runCheck(target).then(() => setDomain(""));
        }}
      >
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="node.example" aria-label={t("admin.federation_check_domain")} className="min-w-0 flex-1" />
        <Button type="submit" disabled={!!running}>
          {t("admin.federation_check_domain")}
        </Button>
      </form>
      {peers.isError && <p className="text-sm text-danger">{describeError(peers.error)}</p>}
      <ul className="divide-y divide-line" data-testid="federation-peer-list">
        {peers.data?.map((p) => (
          <PeerRow key={p.domain} peer={p} running={running === p.domain} busy={busy} open={!!open[p.domain]} onToggle={() => setOpen((o) => ({ ...o, [p.domain]: !o[p.domain] }))} onCheck={() => void runCheck(p.domain)} onBlock={() => void act(() => api.admin.blockPeer(p.domain))} onUnblock={() => void act(() => api.admin.unblockPeer(p.domain))} />
        ))}
        {peers.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("admin.federation_none")}</li>}
      </ul>
      <ReportsSection />
    </Section>
  );
}

/**
 * Reports of this node's users about other nodes (FEDERATION.md §9.2): count per node, the reports of a
 * node on demand, delisting the node from the directory and dismissing the reports.
 */
function ReportsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const reports = useQuery({ queryKey: ["admin", "reports"], queryFn: () => api.admin.reports() });
  const [open, setOpen] = useState<string | null>(null);
  const { run: act, busy } = useAction({ refresh: () => queryClient.invalidateQueries({ queryKey: ["admin", "reports"] }) });
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">{t("admin.reports")}</h3>
      <p className="text-xs text-fg-2">{t("admin.reports_hint")}</p>
      {reports.isError && <p className="text-sm text-danger">{describeError(reports.error)}</p>}
      {reports.data?.length === 0 && <p className="text-sm text-fg-2">{t("admin.reports_none")}</p>}
      <ul className="divide-y divide-line" data-testid="report-list">
        {reports.data?.map((r) => (
          <ReportRow
            key={r.domain}
            summary={r}
            open={open === r.domain}
            busy={busy}
            onToggle={() => setOpen((o) => (o === r.domain ? null : r.domain))}
            onDelist={() => void act(() => api.admin.delistNode(r.domain))}
            onRelist={() => void act(() => api.admin.relist(r.domain))}
            onDismiss={() =>
              void act(async () => {
                await api.admin.dismissReports(r.domain);
                setOpen(null);
              })
            }
          />
        ))}
      </ul>
    </div>
  );
}

function ReportRow({ summary: r, open, busy, onToggle, onDelist, onRelist, onDismiss }: { summary: ReportSummary; open: boolean; busy: boolean; onToggle: () => void; onDelist: () => void; onRelist: () => void; onDismiss: () => void }) {
  const t = useT();
  const list = useQuery({ queryKey: ["admin", "reports", r.domain], queryFn: () => api.admin.reportsOf(r.domain), enabled: open });
  return (
    <li className="space-y-2 py-3 text-sm" data-testid="report-node" data-domain={r.domain}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-xs text-fg-0">{r.domain}</span>
        <span className="rounded bg-danger/15 px-1.5 text-xs font-medium text-danger" data-testid="report-count">
          {t("admin.reports_count", { count: r.reports })}
        </span>
        {r.delisted && <span className="rounded bg-bg-3 px-1.5 text-xs text-fg-2">{t("admin.reports_delisted")}</span>}
      </div>
      <p className="text-xs text-fg-2">{t("admin.reports_summary", { reporters: r.reporters, recent: r.recent, date: new Date(r.last_at).toLocaleString(intlLocale()) })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" aria-expanded={open} onClick={onToggle}>
          {open ? t("admin.reports_hide") : t("admin.reports_show")}
        </Button>
        {r.delisted ? (
          <Button variant="ghost" disabled={busy} onClick={onRelist}>
            {t("admin.reports_relist")}
          </Button>
        ) : (
          <Button variant="danger" disabled={busy} onClick={onDelist}>
            {t("admin.reports_delist")}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onDismiss}>
          {t("admin.reports_dismiss")}
        </Button>
      </div>
      {open && (
        <ul className="divide-y divide-line rounded-md border border-line bg-bg-0 text-xs" data-testid="report-entries">
          {list.isPending && <li className="px-2 py-1.5 text-fg-2">{t("common.loading")}</li>}
          {list.data?.map((e: DirectoryReport) => (
            <li key={e.id} className="space-y-0.5 px-2 py-1.5" data-testid="report-entry" data-check={e.check}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-fg-1">{e.check}</span>
                {e.room_id && <span className="font-mono text-fg-2">{t("admin.reports_room", { id: e.room_id })}</span>}
                {e.application && (
                  <span className="break-all font-mono text-fg-2" data-testid="report-application">
                    {t("admin.apps.report_application", { ref: e.application })}
                  </span>
                )}
                <span className="text-fg-2">{e.reporter}</span>
                <time className="text-fg-2" dateTime={e.created_at}>
                  {new Date(e.created_at).toLocaleString(intlLocale())}
                </time>
              </div>
              {e.detail && <p className="whitespace-pre-wrap break-words text-fg-1">{e.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function PeerRow({ peer: p, running, busy, open, onToggle, onCheck, onBlock, onUnblock }: { peer: FederationPeer; running: boolean; busy: boolean; open: boolean; onToggle: () => void; onCheck: () => void; onBlock: () => void; onUnblock: () => void }) {
  const t = useT();
  const blocked = p.status !== "ok";
  return (
    <li className="space-y-2 py-3 text-sm" data-testid="federation-peer" data-domain={p.domain}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-xs text-fg-0">{p.domain}</span>
        <span data-testid="peer-conformance" data-result={p.conformance}>
          <ResultBadge result={p.conformance} label={t(`conformance.${p.conformance}`)} />
        </span>
        <span data-testid="peer-status" data-status={p.status} className={`rounded px-1.5 text-xs ${blocked ? "bg-danger/15 text-danger" : "text-fg-2"}`}>
          {t(`admin.peer_status.${p.status}`)}
        </span>
      </div>
      <p className="text-xs text-fg-2">
        {p.checked_at ? t("admin.federation_checked", { date: new Date(p.checked_at).toLocaleString(intlLocale()) }) : t("admin.federation_never")}
        {" · "}
        {t("admin.federation_counts", { hard: p.hard_failures, soft: p.soft_failures, violations: p.violations })}
      </p>
      {p.blocked_reason && <p className="break-words text-xs text-danger">{p.blocked_reason}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCheck}>
          {running ? t("admin.federation_running") : t("admin.federation_run")}
        </Button>
        {blocked ? (
          <Button variant="ghost" disabled={busy} onClick={onUnblock}>
            {t("admin.federation_unblock")}
          </Button>
        ) : (
          <Button variant="danger" disabled={busy} onClick={onBlock}>
            {t("admin.federation_block")}
          </Button>
        )}
        {p.record && (
          <Button variant="ghost" aria-expanded={open} onClick={onToggle}>
            {open ? t("admin.federation_hide") : t("admin.federation_show")}
          </Button>
        )}
      </div>
      {open && p.record && (
        <ul className="divide-y divide-line rounded-md border border-line bg-bg-0 text-xs" data-testid="conformance-results">
          {p.record.checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1.5" data-testid="conformance-check" data-check={c.id} data-result={c.result}>
              <span className="font-mono text-fg-1">{c.id}</span>
              {c.hard && <span className="text-[10px] uppercase text-fg-2">{t("admin.federation_hard")}</span>}
              <ResultBadge result={c.result} label={t(`conformance.${c.result}`)} />
              {c.detail && <span className="w-full break-words text-fg-2 sm:w-auto">{c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
