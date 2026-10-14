// SPDX-License-Identifier: Apache-2.0
/**
 * The banner of the role preview (docs/CLIENT.md "View the room as a role"): on every page of the previewed room,
 * above the content, with what is simulated (a disclosure with the approximations) and the way out. Leaving the room
 * ends the preview.
 */
import { useEffect, useId, useState } from "react";
import { useT } from "../i18n";
import { useRolePreview } from "../stores/rolePreview";

export function RolePreviewBanner({ roomId }: { roomId: string | undefined }) {
  const t = useT();
  const preview = useRolePreview((s) => s.preview);
  const exit = useRolePreview((s) => s.exit);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  // Another room, a DM, the friends page: the preview belongs to its room only.
  useEffect(() => {
    if (preview && roomId !== preview.roomId) exit();
  }, [preview, roomId, exit]);
  if (!preview || roomId !== preview.roomId) return null;
  const joined = new Date(preview.joinedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <section aria-label={t("roleview.banner_label")} className="shrink-0 border-b border-accent/50 bg-accent-soft px-3 py-2 text-xs text-fg-0" data-testid="role-preview-banner">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden="true">👁</span>
        <p role="status" aria-live="polite" className="min-w-0 flex-1 break-words">
          <strong className="font-semibold" data-testid="role-preview-label">
            {t("roleview.banner", { role: preview.label })}
          </strong>{" "}
          <span className="text-fg-1">· {t("roleview.banner_joined", { date: joined })}</span>
        </p>
        <button
          type="button"
          aria-expanded={details}
          aria-controls={detailsId}
          title={t("roleview.approximations")}
          onClick={() => setDetails((v) => !v)}
          className="min-h-8 rounded-md px-2 font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
          data-testid="role-preview-details"
        >
          {t("roleview.details")}
        </button>
        <button type="button" onClick={exit} className="min-h-8 rounded-md border border-line-strong bg-bg-1 px-3 font-medium text-fg-0 hover:bg-bg-3" data-testid="role-preview-exit">
          {t("roleview.exit")}
        </button>
      </div>
      <p id={detailsId} hidden={!details} className="mt-1 text-fg-1" data-testid="role-preview-approximations">
        {t("roleview.approximations")}
      </p>
    </section>
  );
}
