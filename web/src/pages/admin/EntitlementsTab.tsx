// SPDX-License-Identifier: Apache-2.0
/**
 * Node admin: entitlement plans and grants (design note 4.13 item 1, tavrn-protocol/ENTITLEMENTS.md). Plans bundle
 * limits; grants give a plan and/or per-key overrides to a local user or a room, optionally until a date.
 * The node evaluates them; this page only edits the data and previews the effective values.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Grant, KeyInfo, Plan } from "@tavrn/sdk";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { describeError, toastError } from "../../stores/toasts";
import { formatSize } from "../../components/AttachmentView";
import { Button, Field, Input } from "../../components/ui";
import { ConfirmDialog, Section, Select } from "../settings/common";

export type Limits = Record<string, number>;

/** Keys whose values are bytes (shown with a size next to the number). */
const BYTE_KEYS = new Set(["upload.max_bytes", "storage.max_bytes_per_room", "files_channels.max_bytes"]);

/** A limit value for humans: sizes for byte keys, "unlimited" for 0 where 0 means unlimited. */
export function formatLimit(key: string, value: number, t: ReturnType<typeof useT>, rule?: string): string {
  if (rule === "flag" || key === "files_channels.enabled") return value ? t("common.yes") : t("common.no");
  if (value === 0) return key === "attachments.retention_days" ? t("entitlements.keep_forever") : t("entitlements.unlimited");
  if (BYTE_KEYS.has(key)) return formatSize(value);
  return String(value);
}

/** `datetime-local` value ⇄ RFC 3339. */
export function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Rows of key/value inputs for plan limits and grant overrides. */
export function LimitsEditor({ keys, value, onChange, idPrefix }: { keys: KeyInfo[]; value: Limits; onChange: (next: Limits) => void; idPrefix: string }) {
  const t = useT();
  const unused = keys.filter((k) => !(k.key in value));
  return (
    <div className="space-y-2" data-testid={`${idPrefix}-limits`}>
      {Object.entries(value).map(([key, v]) => {
        const info = keys.find((k) => k.key === key);
        return (
          <div key={key} className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${idPrefix}-${key}`} className="min-w-0 flex-1 basis-40 text-sm text-fg-1">
              {t(`entitlements.key.${key}`)}
              <span className="block font-mono text-[11px] text-fg-2">{key}</span>
            </label>
            <Input
              id={`${idPrefix}-${key}`}
              type="number"
              min={0}
              max={info?.max}
              value={String(v)}
              onChange={(e) => onChange({ ...value, [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              className="w-36 flex-none"
            />
            <span className="w-24 text-xs text-fg-2">{formatLimit(key, v, t, info?.rule)}</span>
            <Button
              variant="ghost"
              aria-label={t("entitlements.remove_limit", { key })}
              onClick={() => {
                const next = { ...value };
                delete next[key];
                onChange(next);
              }}
            >
              ×
            </Button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <Select
          aria-label={t("entitlements.add_limit")}
          value=""
          onChange={(e) => {
            const key = e.target.value;
            const info = keys.find((k) => k.key === key);
            if (key) onChange({ ...value, [key]: info?.node_default ?? 0 });
          }}
        >
          <option value="">{t("entitlements.add_limit")}</option>
          {unused.map((k) => (
            <option key={k.key} value={k.key}>
              {t(`entitlements.key.${k.key}`)}
            </option>
          ))}
        </Select>
      )}
      <p className="text-xs text-fg-2">{t("entitlements.limits_hint")}</p>
    </div>
  );
}

function LimitChips({ limits, keys }: { limits: Limits; keys: KeyInfo[] }) {
  const t = useT();
  const entries = Object.entries(limits);
  if (entries.length === 0) return <span className="text-xs text-fg-2">{t("entitlements.no_limits")}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-bg-3 px-1.5 py-0.5 text-xs text-fg-1" title={k}>
          {t(`entitlements.key.${k}`)}: {formatLimit(k, v, t, keys.find((x) => x.key === k)?.rule)}
        </span>
      ))}
    </span>
  );
}

export function EntitlementsTab() {
  const t = useT();
  const keys = useQuery({ queryKey: ["admin", "entitlement-keys"], queryFn: () => api.admin.entitlementKeys() });
  if (keys.isError) return <p className="text-sm text-danger">{describeError(keys.error)}</p>;
  if (!keys.data) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  return (
    <div className="space-y-4">
      <PlansSection keys={keys.data} />
      <GrantsSection keys={keys.data} />
      <EffectiveSection keys={keys.data} />
    </div>
  );
}

function PlansSection({ keys }: { keys: KeyInfo[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.admin.plans() });
  const [name, setName] = useState("");
  const [limits, setLimits] = useState<Limits>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "plans"] });
  return (
    <Section title={t("entitlements.plans")} description={t("entitlements.plans_hint")}>
      <form
        className="space-y-2 rounded-md border border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.admin.createPlan({ name, limits });
            setName("");
            setLimits({});
            await refresh();
          } catch (err) {
            toastError(err);
          }
        }}
      >
        <Field label={t("entitlements.plan_name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </Field>
        <LimitsEditor keys={keys} value={limits} onChange={setLimits} idPrefix="new-plan" />
        <div className="flex justify-end">
          <Button type="submit">{t("entitlements.plan_create")}</Button>
        </div>
      </form>
      {plans.isError && <p className="text-sm text-danger">{describeError(plans.error)}</p>}
      <ul className="divide-y divide-line" data-testid="plan-list">
        {plans.data?.map((p) =>
          editing === p.id ? (
            <li key={p.id} className="py-2">
              <PlanEditor
                plan={p}
                keys={keys}
                onDone={async () => {
                  setEditing(null);
                  await refresh();
                  await queryClient.invalidateQueries({ queryKey: ["admin", "grants"] });
                }}
              />
            </li>
          ) : (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-fg-2">{t("entitlements.plan_grants", { count: p.grants })}</span>
              <span className="basis-full sm:basis-auto sm:flex-1">
                <LimitChips limits={p.limits} keys={keys} />
              </span>
              <Button variant="ghost" onClick={() => setEditing(p.id)}>
                {t("common.edit")}
              </Button>
              <Button variant="ghost" onClick={() => setDeleting(p)}>
                {t("common.delete")}
              </Button>
            </li>
          ),
        )}
        {plans.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("entitlements.no_plans")}</li>}
      </ul>
      {deleting && (
        <ConfirmDialog
          open
          title={t("entitlements.plan_delete_title", { name: deleting.name })}
          text={t("entitlements.plan_delete_text")}
          actionLabel={t("common.delete")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.admin.deletePlan(deleting.id);
            setDeleting(null);
            await refresh();
          }}
        />
      )}
    </Section>
  );
}

function PlanEditor({ plan, keys, onDone }: { plan: Plan; keys: KeyInfo[]; onDone: () => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(plan.name);
  const [limits, setLimits] = useState<Limits>(plan.limits);
  return (
    <form
      className="space-y-2 rounded-md border border-accent/40 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.admin.updatePlan(plan.id, { name, limits });
          await onDone();
        } catch (err) {
          toastError(err);
        }
      }}
    >
      <Field label={t("entitlements.plan_name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      </Field>
      <LimitsEditor keys={keys} value={limits} onChange={setLimits} idPrefix={`plan-${plan.id}`} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => void onDone()}>
          {t("common.cancel")}
        </Button>
        <Button type="submit">{t("common.save")}</Button>
      </div>
    </form>
  );
}

function GrantsSection({ keys }: { keys: KeyInfo[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [includeExpired, setIncludeExpired] = useState(false);
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.admin.plans() });
  const grants = useQuery({
    queryKey: ["admin", "grants", applied, includeExpired],
    queryFn: () => api.admin.grants({ subject: applied || undefined, include_expired: includeExpired, limit: 200 }),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Grant | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "grants"] });
  return (
    <Section title={t("entitlements.grants")} description={t("entitlements.grants_hint")}>
      <GrantForm keys={keys} plans={plans.data ?? []} onDone={refresh} />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filter.trim());
        }}
      >
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="user:alice · room:01J…" aria-label={t("entitlements.filter_subject")} className="min-w-0 flex-1" />
        <Button type="submit" variant="ghost">
          {t("entitlements.filter")}
        </Button>
        <label className="flex min-h-10 items-center gap-2 text-sm text-fg-1">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={includeExpired} onChange={(e) => setIncludeExpired(e.target.checked)} />
          {t("entitlements.include_expired")}
        </label>
      </form>
      {grants.isError && <p className="text-sm text-danger">{describeError(grants.error)}</p>}
      <ul className="divide-y divide-line" data-testid="grant-list">
        {grants.data?.map((g) =>
          editing === g.id ? (
            <li key={g.id} className="py-2">
              <GrantForm
                keys={keys}
                plans={plans.data ?? []}
                grant={g}
                onDone={async () => {
                  setEditing(null);
                  await refresh();
                }}
              />
            </li>
          ) : (
            <li key={g.id} className="space-y-1 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{g.subject_label || g.subject}</span>
                <span className="rounded bg-bg-3 px-1.5 text-xs text-fg-2">{t(`entitlements.subject.${g.subject_kind}`)}</span>
                {g.plan_name && <span className="rounded bg-accent-soft px-1.5 text-xs text-accent">{g.plan_name}</span>}
                {g.expired && <span className="rounded bg-danger/15 px-1.5 text-xs text-danger">{t("entitlements.expired")}</span>}
                <span className="text-xs text-fg-2">
                  {g.expires_at ? t("entitlements.expires_on", { date: new Date(g.expires_at).toLocaleString(intlLocale()) }) : t("entitlements.no_expiry")}
                </span>
                <span className="flex-1" />
                <Button variant="ghost" onClick={() => setEditing(g.id)}>
                  {t("common.edit")}
                </Button>
                <Button variant="ghost" onClick={() => setDeleting(g)}>
                  {t("common.delete")}
                </Button>
              </div>
              {Object.keys(g.overrides).length > 0 && <LimitChips limits={g.overrides} keys={keys} />}
              {g.note && <p className="text-xs text-fg-2">{g.note}</p>}
            </li>
          ),
        )}
        {grants.data?.length === 0 && <li className="py-2 text-sm text-fg-2">{t("entitlements.no_grants")}</li>}
      </ul>
      {deleting && (
        <ConfirmDialog
          open
          title={t("entitlements.grant_delete_title")}
          text={t("entitlements.grant_delete_text", { subject: deleting.subject_label || deleting.subject })}
          actionLabel={t("common.delete")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.admin.deleteGrant(deleting.id);
            setDeleting(null);
            await refresh();
          }}
        />
      )}
    </Section>
  );
}

/** Create a grant, or edit one (`grant` given: the subject stays). */
function GrantForm({ keys, plans, grant, onDone }: { keys: KeyInfo[]; plans: Plan[]; grant?: Grant; onDone: () => Promise<unknown> }) {
  const t = useT();
  const [subject, setSubject] = useState("");
  const [planId, setPlanId] = useState(grant?.plan_id ?? "");
  const [overrides, setOverrides] = useState<Limits>(grant?.overrides ?? {});
  const [expires, setExpires] = useState(toLocalInput(grant?.expires_at));
  const [note, setNote] = useState(grant?.note ?? "");
  const prefix = grant ? `grant-${grant.id}` : "new-grant";
  return (
    <form
      className={`space-y-2 rounded-md border p-3 ${grant ? "border-accent/40" : "border-line"}`}
      data-testid={grant ? "grant-editor" : "grant-create"}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const expires_at = toIso(expires);
          if (grant) {
            await api.admin.updateGrant(grant.id, { plan_id: planId || null, overrides, expires_at, note });
          } else {
            await api.admin.createGrant({ subject: subject.trim(), plan_id: planId || null, overrides, expires_at, note });
            setSubject("");
            setOverrides({});
            setExpires("");
            setNote("");
            setPlanId("");
          }
          await onDone();
        } catch (err) {
          toastError(err);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {grant ? (
          <p className="text-sm">
            <span className="text-xs text-fg-2">{t("entitlements.subject")}: </span>
            {grant.subject_label || grant.subject}
          </p>
        ) : (
          <Field label={t("entitlements.subject")} hint={t("entitlements.subject_hint")}>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="user:alice" required />
          </Field>
        )}
        <Field label={t("entitlements.plan")}>
          <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">{t("entitlements.no_plan")}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("entitlements.expires_at")} hint={t("entitlements.expires_hint")}>
          <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <Field label={t("entitlements.note")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
      <p className="text-xs font-medium text-fg-1">{t("entitlements.overrides")}</p>
      <LimitsEditor keys={keys} value={overrides} onChange={setOverrides} idPrefix={prefix} />
      <div className="flex justify-end gap-2">
        {grant && (
          <Button variant="ghost" onClick={() => void onDone()}>
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit">{grant ? t("common.save") : t("entitlements.grant_create")}</Button>
      </div>
    </form>
  );
}

/** Effective values for a user and/or a room (preview of the evaluation). */
function EffectiveSection({ keys }: { keys: KeyInfo[] }) {
  const t = useT();
  const [user, setUser] = useState("");
  const [room, setRoom] = useState("");
  const [query, setQuery] = useState<{ user?: string; room?: string } | null>(null);
  const effective = useQuery({
    queryKey: ["admin", "effective", query],
    queryFn: () => api.admin.effectiveEntitlements(query!),
    enabled: !!query,
  });
  return (
    <Section title={t("entitlements.effective")} description={t("entitlements.effective_hint")}>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ user: user.trim() || undefined, room: room.trim() || undefined });
        }}
      >
        <Field label={t("entitlements.effective_user")}>
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="alice" />
        </Field>
        <Field label={t("entitlements.effective_room")}>
          <Input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="01J…" />
        </Field>
        <Button type="submit" variant="ghost">
          {t("entitlements.effective_show")}
        </Button>
      </form>
      {effective.isError && <p className="text-sm text-danger">{describeError(effective.error)}</p>}
      {effective.data && (
        <dl className="divide-y divide-line text-sm" data-testid="effective-values">
          {keys.map((k) => {
            const v = effective.data.values[k.key] ?? 0;
            const d = effective.data.node_defaults[k.key] ?? 0;
            return (
              <div key={k.key} className="flex min-h-9 flex-wrap items-center justify-between gap-x-4">
                <dt className="text-fg-1">{t(`entitlements.key.${k.key}`)}</dt>
                <dd className={v !== d ? "font-medium text-accent" : "text-fg-1"}>
                  {formatLimit(k.key, v, t, k.rule)}
                  {v !== d && <span className="ml-2 text-xs text-fg-2">({t("entitlements.node_default")}: {formatLimit(k.key, d, t, k.rule)})</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </Section>
  );
}
