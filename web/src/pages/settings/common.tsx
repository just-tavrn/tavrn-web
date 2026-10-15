// SPDX-License-Identifier: Apache-2.0
import { useId, useState, type ReactNode } from "react";
import { CHANNEL_SCOPED_GROUPS, PERMISSION_LABELS, Permission, hasPermission, type InheritedSource, type PermissionName } from "@tavrn/sdk";
import { useT } from "../../i18n";
import { describeError } from "../../stores/toasts";
import { Button, Dialog, ErrorText, Input } from "../../components/ui";

export function Section({ title, children, description }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-bg-1 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-1 text-xs text-fg-2">{description}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`min-h-10 w-full rounded-md border border-line-strong bg-bg-0 px-3 text-sm ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`w-full rounded-md border border-line-strong bg-bg-0 px-3 py-2 text-sm text-fg-0 outline-none placeholder:text-fg-2 focus:border-accent ${props.className ?? ""}`} />;
}

const GROUPS = [...new Set(PERMISSION_LABELS.map((p) => p.group))];

/** Permission labels come from the SDK in English; localized here via `perm.<NAME>` and `perm.group.<group>`. */
export function usePermissionLabel() {
  const t = useT();
  return {
    label: (name: PermissionName) => {
      const key = `perm.${name}`;
      const translated = t(key);
      return translated === key ? (PERMISSION_LABELS.find((p) => p.name === name)?.label ?? name) : translated;
    },
    group: (group: string) => {
      const key = `perm.group.${group}`;
      const translated = t(key);
      return translated === key ? group : translated;
    },
    /** An explanation shown under the permission, if the locale has one (`perm.hint.<NAME>`). */
    hint: (name: PermissionName) => {
      const key = `perm.hint.${name}`;
      const translated = t(key);
      return translated === key ? null : translated;
    },
  };
}

/**
 * Permissions as checkbox groups. `value` is the bit mask; `limit` restricts to permissions the editor has themselves.
 * `restricted` (for `@everyone`, design note 4.11): bits that can only be removed, never granted, with the reason as tooltip.
 */
export function PermissionCheckboxes({ value, onChange, limit, idPrefix = "perm", restricted = 0n }: { value: bigint; onChange: (next: bigint) => void; limit?: bigint; idPrefix?: string; restricted?: bigint }) {
  const t = useT();
  const { label, group, hint } = usePermissionLabel();
  return (
    <div className="space-y-3" data-testid="permission-checkboxes">
      {GROUPS.map((g) => (
        <fieldset key={g}>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{group(g)}</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {PERMISSION_LABELS.filter((p) => p.group === g).map((p) => {
              const bit = Permission[p.name];
              const checked = hasPermission(value, bit);
              const locked = (restricted & bit) !== 0n;
              // A restricted bit that is still set (older rooms) can be removed, never added.
              const allowed = (limit === undefined || hasPermission(limit, bit)) && (!locked || checked);
              return (
                <label key={p.name} className={`flex min-h-9 items-center gap-2 text-sm ${allowed ? "" : "opacity-40"}`} title={locked ? t("members.everyone_restricted_hint") : undefined} data-restricted={locked || undefined}>
                  <input id={`${idPrefix}-${p.name}`} type="checkbox" className="h-4 w-4" checked={checked} disabled={!allowed} onChange={(e) => onChange(e.target.checked ? value | bit : value & ~bit)} aria-description={locked ? t("members.everyone_restricted_hint") : (hint(p.name) ?? undefined)} />
                  <span className="min-w-0">
                    {label(p.name)}
                    {hint(p.name) && <span className="block text-xs text-fg-2" data-testid={`perm-hint-${p.name}`}>{hint(p.name)}</span>}
                  </span>
                  {locked && <span aria-hidden="true" className="text-[10px]">🔒</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export type OverrideState = "allow" | "neutral" | "deny";

export function overrideStateOf(allow: bigint, deny: bigint, bit: bigint): OverrideState {
  if (hasPermission(allow, bit)) return "allow";
  if (hasPermission(deny, bit)) return "deny";
  return "neutral";
}

/** What a neutral override leaves a bit at, and which layer decides it (`inheritedOverrideValue` of the SDK). */
export type Inherited = { allowed: boolean; source: InheritedSource };

/**
 * Three-way choice per permission (allow / neutral / deny) for overrides, listing only the channel-scoped bits in the
 * groups of `CHANNEL_SCOPED_GROUPS` (layered overrides, tavrn-protocol permissions.md). `restricted` bits cannot be
 * allowed (`@everyone`). `inherited` gives the value a neutral bit keeps from the layers below and, inside the edited
 * layer, from its `@everyone` override and a member's role overrides; it is shown in grey under the label and is the accessible description of the bit's radio group and buttons.
 */
export function OverrideTriState({ allow, deny, onChange, restricted = 0n, inherited }: { allow: bigint; deny: bigint; onChange: (allow: bigint, deny: bigint) => void; restricted?: bigint; inherited?: (bit: bigint) => Inherited }) {
  const t = useT();
  const { label } = usePermissionLabel();
  const set = (name: PermissionName, state: OverrideState) => {
    const bit = Permission[name];
    let a = allow & ~bit;
    let d = deny & ~bit;
    if (state === "allow") a |= bit;
    if (state === "deny") d |= bit;
    onChange(a, d);
  };
  return (
    <div className="space-y-3" data-testid="override-tristate">
      {CHANNEL_SCOPED_GROUPS.map((g) => (
        <fieldset key={g.group} data-group={g.group}>
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-fg-2">{t(`channels.perm_group.${g.group}`)}</legend>
          <ul className="mt-1 divide-y divide-line">
            {g.permissions.map((name) => {
              const bit = Permission[name];
              return (
                <TriStateRow
                  key={name}
                  label={label(name)}
                  state={overrideStateOf(allow, deny, bit)}
                  onChange={(s) => set(name, s)}
                  inherited={inherited?.(bit)}
                  inheritedTestId={`inherited-${name}`}
                  lockAllow={(restricted & bit) !== 0n}
                  rowProps={{ "data-permission": name }}
                />
              );
            })}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}

/**
 * One row of an override editor: deny / neutral / allow as a radio group, with what a neutral value inherits in grey
 * under the label (also the group's accessible description). `lockAllow`: allow cannot be chosen (`@everyone`).
 */
export function TriStateRow({ label, state, onChange, inherited, inheritedTestId, lockAllow = false, rowProps }: { label: string; state: OverrideState; onChange: (state: OverrideState) => void; inherited?: Inherited; inheritedTestId?: string; lockAllow?: boolean; rowProps?: Record<string, string> }) {
  const t = useT();
  const descId = `${useId()}-inherited`;
  return (
    <li className="flex min-h-10 items-center justify-between gap-2 py-1 text-sm" {...rowProps}>
      <span className="min-w-0">
        {label}
        {inherited && (
          <span id={descId} className="block text-xs text-fg-2" data-testid={inheritedTestId} data-allowed={inherited.allowed} data-source={inherited.source}>
            {t(`override.inherited.${inherited.allowed ? "allowed" : "denied"}_${inherited.source}`)}
          </span>
        )}
      </span>
      <div role="radiogroup" aria-label={label} aria-describedby={inherited ? descId : undefined} className="flex shrink-0 rounded-md border border-line-strong">
        {(["deny", "neutral", "allow"] as OverrideState[]).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            disabled={lockAllow && s === "allow" && state !== "allow"}
            title={lockAllow && s === "allow" ? t("members.everyone_restricted_hint") : undefined}
            aria-checked={state === s}
            aria-label={`${label}: ${t(`override.${s}`)}`}
            aria-describedby={inherited ? descId : undefined}
            onClick={() => onChange(s)}
            className={`min-h-9 min-w-9 px-2 text-sm disabled:cursor-not-allowed disabled:opacity-30 ${state === s ? (s === "allow" ? "bg-ok/15 text-ok" : s === "deny" ? "bg-danger/15 text-danger" : "bg-bg-3 text-fg-0") : "text-fg-2 hover:bg-bg-3/60"}`}
          >
            {s === "allow" ? "✓" : s === "deny" ? "✗" : "–"}
          </button>
        ))}
      </div>
    </li>
  );
}

/** Confirmation by typing a word, for irreversible actions. */
export function ConfirmDialog({ open, title, text, confirmWord, actionLabel, onConfirm, onClose }: { open: boolean; title: string; text: ReactNode; confirmWord?: string; actionLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !confirmWord || typed === confirmWord;
  // The word is rendered as text (never as HTML), so a name with `&` or entities shows exactly what must be typed.
  const [before, after = ""] = t("common.confirm_type", { word: "\u0000" }).split("\u0000");
  return (
    <Dialog title={title} open={open} onClose={onClose}>
      <div className="space-y-3 text-sm text-fg-1">
        <div>{text}</div>
        {confirmWord && (
          <label className="block space-y-1">
            <span className="text-xs text-fg-2">
              {before}
              <strong className="text-fg-0">{confirmWord}</strong>
              {after}
            </span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("common.confirmation")} autoFocus />
          </label>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={!ready || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                setTyped("");
              } catch (e) {
                setError(describeError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
