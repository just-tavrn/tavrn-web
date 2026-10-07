// SPDX-License-Identifier: Apache-2.0
/**
 * Room settings → Auto-moderation (protocol MODERATION.md §2): the node's flood detection (read-only), the node's
 * own lists, and the room's content rules for its unencrypted channels. The whole list is saved at once; members
 * with `moderate_members` but without `manage_room` see it read-only.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Permission, hasPermission, parsePermissions, type AutomodRule, type RoomDetail } from "@tavrn/sdk";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { channelName } from "../lib/names";
import { describeError, useToasts } from "../stores/toasts";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { Section, Select, Textarea } from "../pages/settings/common";

const ACTIONS = ["block", "delete", "timeout"] as const;
const LINK_MODES = ["off", "block_all", "allow_list", "block_list"] as const;
export const MAX_RULES = 20;

/** One rule as the form edits it: lists as text, one entry per line. */
export interface RuleDraft {
  id: string | null;
  name: string;
  enabled: boolean;
  terms: string;
  wholeWord: boolean;
  links: string;
  domains: string;
  exemptRoles: string[];
  exemptChannels: string[];
  action: string;
  timeoutMinutes: string;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function toDraft(r: AutomodRule): RuleDraft {
  return {
    id: r.id ?? null,
    name: r.name,
    enabled: r.enabled ?? true,
    terms: (r.terms ?? []).join("\n"),
    wholeWord: !!r.whole_word,
    links: r.links ?? "off",
    domains: (r.domains ?? []).join("\n"),
    exemptRoles: r.exempt_roles ?? [],
    exemptChannels: r.exempt_channels ?? [],
    action: r.action,
    timeoutMinutes: r.timeout_minutes ? String(r.timeout_minutes) : "",
  };
}

export function fromDraft(d: RuleDraft): AutomodRule {
  const minutes = Math.floor(Number(d.timeoutMinutes));
  return {
    ...(d.id ? { id: d.id } : {}),
    name: d.name.trim(),
    enabled: d.enabled,
    terms: lines(d.terms),
    whole_word: d.wholeWord,
    links: d.links,
    domains: d.links === "off" ? [] : lines(d.domains),
    exempt_roles: d.exemptRoles,
    exempt_channels: d.exemptChannels,
    action: d.action,
    timeout_minutes: d.action === "timeout" && Number.isFinite(minutes) && minutes > 0 ? minutes : null,
  };
}

export function emptyDraft(name: string): RuleDraft {
  return { id: null, name, enabled: true, terms: "", wholeWord: true, links: "off", domains: "", exemptRoles: [], exemptChannels: [], action: "block", timeoutMinutes: "10" };
}

export function AutomodTab({ room }: { room: RoomDetail }) {
  const t = useT();
  const { api } = useNode();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["automod", room.id], queryFn: () => api.automod.get(room.id) });
  const canEdit = hasPermission(parsePermissions(room.my_permissions), Permission.MANAGE_ROOM);
  const [drafts, setDrafts] = useState<RuleDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data && drafts === null) setDrafts(settings.data.rules.map(toDraft));
  }, [settings.data, drafts]);
  if (settings.isPending) return <p className="text-sm text-fg-2">{t("common.loading")}</p>;
  if (settings.isError) return <ErrorText>{describeError(settings.error)}</ErrorText>;
  const s = settings.data;
  const list = drafts ?? [];
  const roles = room.roles.filter((r) => !r.is_everyone);
  const channels = room.channels.filter((c) => c.kind !== "voice" && c.kind !== "system" && !c.encrypted);
  const update = (i: number, patch: Partial<RuleDraft>) => setDrafts(list.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.automod.set(room.id, list.map(fromDraft));
      queryClient.setQueryData(["automod", room.id], saved);
      setDrafts(saved.rules.map(toDraft));
      useToasts.getState().push({ kind: "info", title: t("automod.saved") });
    } catch (e) {
      // The node's detail names the rule and the problem.
      const problem = (e as { problem?: { code?: string; detail?: string } }).problem;
      const message = describeError(e);
      setError(problem?.code === "automod.rules_invalid" && problem.detail && !message.includes(problem.detail) ? `${message} (${problem.detail})` : message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="automod-tab">
      <Section title={t("automod.flood.title")} description={t("automod.flood.hint")}>
        <p className="text-sm text-fg-1" data-testid="automod-burst">
          {s.burst.limit > 0 ? t("automod.flood.active", { limit: s.burst.limit, secs: s.burst.window_secs, minutes: s.burst.timeout_minutes }) : t("automod.flood.off")}
        </p>
        {(s.node.words || s.node.links) && (
          <p className="text-xs text-fg-2" data-testid="automod-node-lists">
            {t("automod.node_lists")}
          </p>
        )}
      </Section>
      <Section title={t("automod.rules.title")} description={t("automod.rules.hint")}>
        <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-2" data-testid="automod-plaintext-only">
          {t("automod.rules.plaintext_only")}
        </p>
        {!canEdit && <p className="text-xs text-fg-2">{t("automod.rules.read_only")}</p>}
        <ol className="space-y-3" data-testid="automod-rules">
          {list.map((d, i) => (
            <li key={d.id ?? `new-${i}`} className="space-y-3 rounded-md border border-line p-3" data-testid="automod-rule">
              <fieldset disabled={!canEdit} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <Field label={t("automod.rule.name")}>
                    <Input value={d.name} maxLength={64} onChange={(e) => update(i, { name: e.target.value })} data-testid="automod-rule-name" />
                  </Field>
                  <label className="flex min-h-10 items-center gap-2 self-end text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={d.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} data-testid="automod-rule-enabled" />
                    {t("automod.rule.enabled")}
                  </label>
                </div>
                <Field label={t("automod.rule.terms")} hint={t("automod.rule.terms_hint")}>
                  <Textarea rows={3} value={d.terms} onChange={(e) => update(i, { terms: e.target.value })} spellCheck={false} data-testid="automod-rule-terms" />
                </Field>
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={d.wholeWord} onChange={(e) => update(i, { wholeWord: e.target.checked })} data-testid="automod-rule-whole-word" />
                  {t("automod.rule.whole_word")}
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("automod.rule.links")}>
                    <Select value={d.links} onChange={(e) => update(i, { links: e.target.value })} data-testid="automod-rule-links">
                      {LINK_MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(`automod.links.${m}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {(d.links === "allow_list" || d.links === "block_list") && (
                    <Field label={t("automod.rule.domains")} hint={t("automod.rule.domains_hint")}>
                      <Textarea rows={2} value={d.domains} onChange={(e) => update(i, { domains: e.target.value })} spellCheck={false} data-testid="automod-rule-domains" />
                    </Field>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("automod.rule.action")}>
                    <Select value={d.action} onChange={(e) => update(i, { action: e.target.value })} data-testid="automod-rule-action">
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {t(`automod.action.${a}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {d.action === "timeout" && (
                    <Field label={t("automod.rule.timeout_minutes")}>
                      <Input type="number" min={1} max={40320} value={d.timeoutMinutes} onChange={(e) => update(i, { timeoutMinutes: e.target.value })} data-testid="automod-rule-timeout" />
                    </Field>
                  )}
                </div>
                {(roles.length > 0 || channels.length > 0) && (
                  <details className="text-sm">
                    <summary className="min-h-9 cursor-pointer py-2 text-fg-1">{t("automod.rule.exemptions", { count: d.exemptRoles.length + d.exemptChannels.length })}</summary>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {roles.length > 0 && (
                        <div>
                          <p className="mb-1 text-xs text-fg-2">{t("automod.rule.exempt_roles")}</p>
                          {roles.map((r) => (
                            <label key={r.id} className="flex min-h-9 items-center gap-2">
                              <input type="checkbox" className="h-4 w-4" checked={d.exemptRoles.includes(r.id)} onChange={(e) => update(i, { exemptRoles: e.target.checked ? [...d.exemptRoles, r.id] : d.exemptRoles.filter((x) => x !== r.id) })} />
                              {r.name}
                            </label>
                          ))}
                        </div>
                      )}
                      {channels.length > 0 && (
                        <div>
                          <p className="mb-1 text-xs text-fg-2">{t("automod.rule.exempt_channels")}</p>
                          {channels.map((c) => (
                            <label key={c.id} className="flex min-h-9 items-center gap-2">
                              <input type="checkbox" className="h-4 w-4" checked={d.exemptChannels.includes(c.id)} onChange={(e) => update(i, { exemptChannels: e.target.checked ? [...d.exemptChannels, c.id] : d.exemptChannels.filter((x) => x !== c.id) })} />#{channelName(c)}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>
                )}
                {canEdit && (
                  <div className="flex justify-end">
                    <Button variant="ghost" className="text-danger" onClick={() => setDrafts(list.filter((_, j) => j !== i))} data-testid="automod-rule-remove">
                      {t("automod.rule.remove")}
                    </Button>
                  </div>
                )}
              </fieldset>
            </li>
          ))}
          {list.length === 0 && <li className="text-sm text-fg-2">{t("automod.rules.none")}</li>}
        </ol>
        <ErrorText>{error}</ErrorText>
        {canEdit && (
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" disabled={list.length >= MAX_RULES} onClick={() => setDrafts([...list, emptyDraft(t("automod.rule.default_name", { n: list.length + 1 }))])} data-testid="automod-rule-add">
              + {t("automod.rule.add")}
            </Button>
            <Button disabled={busy} onClick={() => void save()} data-testid="automod-save">
              {t("common.save")}
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}
