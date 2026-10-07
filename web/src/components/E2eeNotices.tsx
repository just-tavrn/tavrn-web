// SPDX-License-Identifier: Apache-2.0
import { Link, useLocation } from "react-router";
import { useT } from "../i18n";
import type { GhostViolation } from "@tavrn/e2ee";
import { Button } from "./ui";

/** Encrypted conversation on a device that cannot decrypt (no key, locked, skipped): unlock link. */
export function LockedNotice() {
  const t = useT();
  const location = useLocation();
  return (
    <div role="status" data-testid="e2ee-locked" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg-1 px-4 py-2 text-sm text-fg-1">
      <span aria-hidden="true">🔒</span>
      <span className="min-w-0 flex-1">{t("e2ee.conversation_locked")}</span>
      <Link to={`/encryption?next=${encodeURIComponent(location.pathname)}`} className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover">
        {t("e2ee.banner_unlock_action")}
      </Link>
    </div>
  );
}

/**
 * Ghost member warning (ENCRYPTION.md §4.6): stays visible while the roster contains a device that is
 * not a member or not attested, or a bot in a "no bots" channel (APPLICATIONS.md §3.5, explained separately);
 * sending is blocked until the user acknowledged it.
 */
export function GhostWarning({ ghosts, acknowledged, onAcknowledge }: { ghosts: GhostViolation[]; acknowledged: boolean; onAcknowledge: () => void }) {
  const t = useT();
  if (ghosts.length === 0) return null;
  return (
    <div role="alert" data-testid="ghost-warning" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-fg-0">
      <p className="font-semibold text-danger">⚠ {t("e2ee.ghost_title")}</p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {ghosts.map((g) => (
          <li key={`${g.identity}-${g.reason}`} className="break-all">
            <code>{g.identity}</code> – {t(`e2ee.ghost.${g.reason}`)}
          </li>
        ))}
      </ul>
      {ghosts.some((g) => g.reason === "bot") && (
        <p data-testid="ghost-bot-hint" className="mt-1 text-xs text-fg-1">
          {t("e2ee.ghost_bot_hint")}
        </p>
      )}
      <p className="mt-1 text-xs text-fg-1">{t("e2ee.ghost_hint")}</p>
      {!acknowledged && (
        <Button variant="danger" className="mt-2" onClick={onAcknowledge}>
          {t("e2ee.ghost_ack")}
        </Button>
      )}
    </div>
  );
}

/** Small status line under the header (joining, waiting for the other device, rejoined after an error). */
export function E2eeStatusLine({ kind, detail }: { kind: "joining" | "waiting" | "rejoined" | "error" | "no_group" | "history"; detail?: string }) {
  const t = useT();
  const tone = kind === "error" || kind === "rejoined" ? "border-warn/40 bg-warn/10 text-warn" : "border-line bg-bg-1 text-fg-2";
  return (
    <div role="status" data-testid={`e2ee-${kind}`} className={`border-b px-4 py-1.5 text-xs ${tone}`}>
      {t(`e2ee.status.${kind}`, { detail: detail ?? "" })}
    </div>
  );
}
