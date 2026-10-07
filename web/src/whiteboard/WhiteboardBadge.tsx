// SPDX-License-Identifier: Apache-2.0
/**
 * Small whiteboard indicators for other views: a badge while a board is open, the live thumbnail for tiles,
 * and the header button that leads to the board (with the badge's dot while one is open).
 */
import { Link, useLocation } from "react-router";
import { useT } from "../i18n";
import { useWhiteboardSession } from "./store";

/** "Whiteboard live" while a session exists in the conversation (nothing otherwise). */
export function WhiteboardBadge({ conversationId, encrypted, className = "" }: { conversationId: string; encrypted?: boolean; className?: string }) {
  const t = useT();
  const { session } = useWhiteboardSession(conversationId, { encrypted });
  if (!session) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent ${className}`} data-testid="whiteboard-badge" title={t("whiteboard.badge")}>
      <span aria-hidden="true">🖍</span>
      {t("whiteboard.badge")}
    </span>
  );
}

/** The owner's latest thumbnail of the board (refreshed every few seconds while it changes). */
export function WhiteboardThumbnail({ conversationId, encrypted, className = "" }: { conversationId: string; encrypted?: boolean; className?: string }) {
  const t = useT();
  const { session, thumbnailUrl } = useWhiteboardSession(conversationId, { encrypted });
  if (!session) return null;
  if (!thumbnailUrl) {
    return (
      <div role="img" className={`flex items-center justify-center bg-bg-2 text-2xl ${className}`} data-testid="whiteboard-thumbnail" aria-label={t("whiteboard.badge")}>
        🖍
      </div>
    );
  }
  return <img src={thumbnailUrl} alt={t("whiteboard.badge")} className={`object-contain ${className}`} data-testid="whiteboard-thumbnail" />;
}

/** Header button of a conversation: opens its whiteboard (route `…/whiteboard`). */
export function WhiteboardButton({ conversationId, encrypted }: { conversationId: string; encrypted?: boolean }) {
  const t = useT();
  const location = useLocation();
  const { session } = useWhiteboardSession(conversationId, { encrypted });
  const to = `${location.pathname.replace(/\/+$/, "")}/whiteboard`;
  return (
    <Link
      to={to}
      aria-label={session ? t("whiteboard.button_live") : t("whiteboard.button")}
      title={session ? t("whiteboard.button_live") : t("whiteboard.button")}
      data-testid="whiteboard-button"
      data-live={!!session}
      className="relative inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0"
    >
      🖍
      {session && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" />}
    </Link>
  );
}
