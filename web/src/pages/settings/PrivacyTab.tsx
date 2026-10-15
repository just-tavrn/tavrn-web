// SPDX-License-Identifier: Apache-2.0
/**
 * Privacy and safety (design note 4.9): who can message me (under the node's bound), hiding the activity,
 * the programs allowed to show my game activity (APPLICATIONS.md §7.3) and the personal block list with
 * private notes.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LocalIndexSection } from "../../search/LocalIndexSection";
import { api } from "../../lib/api";
import { intlLocale, useT } from "../../i18n";
import { useAuth } from "../../stores/auth";
import { describeError, toastError, useToasts } from "../../stores/toasts";
import { UserAvatar } from "../../components/Avatar";
import { Button } from "../../components/ui";
import { Section } from "./common";
import { usePrivacy } from "../../stores/privacy";
import { AUTO_PREVIEW_VALUES, type AutoPreview } from "../../lib/preview";
import { formatSize } from "../../components/AttachmentView";
import { ContentPrivacySection } from "./ContentPrivacySection";
import { AllowedAppsSection } from "../../activity/AllowedAppsSection";
import { DeleteAccountSection } from "./AccountDataSections";
import { nodeInfoQuery } from "../../lib/queries";

const POLICIES = ["friends", "everyone_shared", "everyone"] as const;
type Policy = (typeof POLICIES)[number];

export function PrivacyTab() {
  return (
    <div className="space-y-4">
      <DmPolicySection />
      <AllowedAppsSection />
      <AutoPreviewSection />
      <ContentPrivacySection />
      <BlockedUsersList />
      <LocalIndexSection />
      <DeleteAccountSection />
    </div>
  );
}

function DmPolicySection() {
  const t = useT();
  const queryClient = useQueryClient();
  const address = useAuth((s) => s.user?.address ?? "");
  const profile = useQuery({ queryKey: ["profile", "me", address], queryFn: () => api.users.profile(address), enabled: !!address });
  const presence = useQuery({ queryKey: ["presence", "me"], queryFn: () => api.presence.mine() });
  const node = useQuery(nodeInfoQuery(null));
  const bound = (node.data?.dm_policy === "open" ? "everyone" : node.data?.dm_policy) as Policy | undefined;
  const allowed = (p: Policy) => !bound || POLICIES.indexOf(p) <= POLICIES.indexOf(bound);
  const current = profile.data?.dm_policy as Policy | undefined;
  const save = async (patch: { dm_policy?: Policy; hide_activity?: boolean }) => {
    try {
      await api.users.updateMe(patch);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["profile"] }), queryClient.invalidateQueries({ queryKey: ["presence", "me"] })]);
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <Section title={t("privacy.dm_title")} description={t("privacy.dm_hint")}>
        <div role="radiogroup" aria-label={t("privacy.dm_title")} className="space-y-1" data-testid="dm-policy">
          {POLICIES.map((p) => (
            <label key={p} className={`flex min-h-10 items-center gap-2 text-sm ${allowed(p) ? "" : "opacity-50"}`}>
              <input type="radio" name="dm_policy" value={p} className="h-4 w-4 accent-accent" checked={current === p} disabled={!allowed(p) || !current} onChange={() => void save({ dm_policy: p })} />
              {t(`privacy.dm.${p}`)}
            </label>
          ))}
        </div>
        {bound && bound !== "everyone" && <p className="text-xs text-fg-2">{t("privacy.node_bound", { policy: t(`privacy.dm.${bound}`) })}</p>}
      </Section>
      <Section title={t("privacy.activity_title")}>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={!!presence.data?.hide_activity} disabled={!presence.data} onChange={(e) => void save({ hide_activity: e.target.checked })} data-testid="hide-activity" />
          {t("privacy.hide_activity")}
        </label>
        <p className="text-xs text-fg-2">{t("privacy.hide_activity_hint")}</p>
      </Section>
    </>
  );
}

/**
 * "Load image previews automatically" (design note 4.12): saved on the home node, mirrored locally so the chat
 * uses it at once. Larger images than the node's cap always wait for a click.
 */
function AutoPreviewSection() {
  const t = useT();
  const current = usePrivacy((s) => s.autoPreview);
  const maxBytes = usePrivacy((s) => s.maxBytes);
  const choose = async (value: AutoPreview) => {
    try {
      await usePrivacy.getState().save(value, (v) => api.users.updateMe({ auto_preview: v }));
      useToasts.getState().push({ kind: "info", title: t("common.saved") });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Section title={t("privacy.preview_title")} description={t("privacy.preview_hint")}>
      <div role="radiogroup" aria-label={t("privacy.preview_title")} className="space-y-1" data-testid="auto-preview">
        {AUTO_PREVIEW_VALUES.map((v) => (
          <label key={v} className="flex min-h-10 items-center gap-2 text-sm">
            <input type="radio" name="auto_preview" value={v} className="h-4 w-4 accent-accent" checked={current === v} onChange={() => void choose(v)} />
            {t(`privacy.preview.${v}`)}
          </label>
        ))}
      </div>
      <p className="text-xs text-fg-2" data-testid="auto-preview-cap">
        {t("privacy.preview_cap", { size: formatSize(maxBytes) })}
      </p>
    </Section>
  );
}

/** Everyone I blocked, with my private note and the date; unblock from here. */
export function BlockedUsersList() {
  const t = useT();
  const queryClient = useQueryClient();
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: () => api.blocks.list() });
  const unblock = async (address: string) => {
    try {
      await api.blocks.unblock(address);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["blocks"] }), queryClient.invalidateQueries({ queryKey: ["friends"] })]);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Section title={t("privacy.blocked")} description={t("privacy.blocked_hint")}>
      {blocks.isError && <p className="text-sm text-danger">{describeError(blocks.error)}</p>}
      {blocks.data?.length === 0 && <p className="text-sm text-fg-2">{t("privacy.blocked_none")}</p>}
      <ul className="divide-y divide-line" data-testid="blocked-list">
        {blocks.data?.map((b) => (
          <li key={b.user.address} className="flex flex-wrap items-center gap-3 py-2" data-testid="blocked-user" data-address={b.user.address}>
            <UserAvatar user={b.user} size={32} node={null} />
            <div className="min-w-0 flex-[1_1_12rem]">
              <p className="truncate text-sm">{b.user.display_name}</p>
              <p className="truncate text-xs text-fg-2">{b.user.address}</p>
              {b.reason && (
                <p className="text-xs text-fg-1" data-testid="blocked-reason">
                  {t("privacy.reason", { reason: b.reason })}
                </p>
              )}
              <p className="text-xs text-fg-2">{t("privacy.blocked_since", { date: new Date(b.created_at).toLocaleDateString(intlLocale()) })}</p>
            </div>
            <Button variant="ghost" onClick={() => void unblock(b.user.address)} data-testid="unblock">
              {t("friends.unblock")}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
