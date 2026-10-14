// SPDX-License-Identifier: Apache-2.0
/**
 * What the previewed roles may do in a channel where the preview cannot show it by acting (voice: joining would be the
 * viewer's real participation; files: uploads are off). Each right is said in words, not by colour alone.
 */
import { hasPermission } from "@tavrn/sdk";
import { useT } from "../i18n";

export function PreviewRights({ perms, rights, testId }: { perms: bigint; rights: readonly { label: string; bit: bigint }[]; testId: string }) {
  const t = useT();
  return (
    <div className="rounded-md border border-accent/50 bg-accent-soft px-3 py-2 text-left text-sm text-fg-0" data-testid={testId}>
      <p className="mb-1 font-medium">{t("roleview.rights_title")}</p>
      <ul className="space-y-0.5">
        {rights.map((r) => {
          const allowed = hasPermission(perms, r.bit);
          return (
            <li key={r.label} className="flex items-center gap-2" data-right={r.label} data-allowed={allowed}>
              <span aria-hidden="true" className="w-4 text-center">
                {allowed ? "✓" : "✗"}
              </span>
              <span className="min-w-0 flex-1">{r.label}</span>
              <span className="text-xs text-fg-1">{t(allowed ? "roleview.allowed" : "roleview.not_allowed")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
