// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard on the voice stage (design note 4.10): the owner's tile shows a badge and the live thumbnail
 * where a screen share would be, others join on demand from the tile (button or double-click), the joined
 * board is a large stage tile with focus, maximize and popout, the sidebar row of the owner gets a small
 * badge, and the call controls open or close a board. Used by `web/src/voice/ui/*` through small additive
 * hooks; nothing here depends on the voice session beyond its store.
 */
import { lazy, useMemo, useState } from "react";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { toastError } from "../stores/toasts";
import { useWhiteboardSession } from "./store";
import { openBoard, presenterIdentity, tileBoardState } from "./stage";

/** The stage's view of the channel's board. */
export function useStageBoard(channelId: string, identities: readonly string[]) {
  const wb = useWhiteboardSession(channelId);
  const key = identities.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const presenter = useMemo(() => presenterIdentity(wb.session, identities), [wb.session, key]);
  return { ...wb, presenter, visible: !!wb.session && (wb.joined || wb.isOwner) };
}

/**
 * What the board adds to a participant's tile: on the presenter's tile the badge, the live thumbnail and
 * "Join whiteboard session" (double-click joins as well); for the owner a small "watching" mark on the tiles
 * of participants who joined.
 */
export function WhiteboardTileOverlay({ channelId, identity, self, presenter }: { channelId: string; identity: string; self: boolean; presenter: string | null }) {
  const t = useT();
  const { joined, isOwner, join, thumbnailUrl, controller } = useWhiteboardSession(channelId);
  const state = tileBoardState({ identity, self }, presenter, { joined, isOwner, watchers: controller.participants });
  if (state.kind === "none") return null;
  if (state.kind === "watching") {
    return (
      <span className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-fg-0" data-testid="whiteboard-watching" title={t("whiteboard.watching_badge")}>
        🖍 {t("whiteboard.watching_badge")}
      </span>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col bg-bg-2" data-testid="whiteboard-tile-overlay" onDoubleClick={() => state.canJoin && join()}>
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt={t("whiteboard.badge")} className="min-h-0 flex-1 object-contain" data-testid="whiteboard-thumbnail" />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-3xl" aria-hidden="true">
          🖍
        </div>
      )}
      <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-text" data-testid="whiteboard-badge">
        🖍 {t("whiteboard.badge")}
      </span>
      {state.canJoin && (
        <button type="button" onClick={join} className="absolute left-1/2 top-1/2 min-h-9 -translate-x-1/2 -translate-y-1/2 rounded-md bg-accent px-3 text-sm font-medium text-accent-text shadow-lg hover:bg-accent-hover" data-testid="whiteboard-join">
          {t("whiteboard.join")}
        </button>
      )}
      {state.self && (
        <span className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-fg-0" data-testid="whiteboard-joined-count">
          {t("whiteboard.joined_count", { count: state.watching })}
        </span>
      )}
    </div>
  );
}

/**
 * The joined board as a large stage tile (lazy: the board UI and Excalidraw load only when a board is shown).
 */
export const WhiteboardStageTile = lazy(() => import("./WhiteboardStageTile"));

/** Call control: open a whiteboard on the stage (or close the own one). */
export function WhiteboardControl({ channelId, canOpen, className = "" }: { channelId: string; canOpen: boolean; className?: string }) {
  const t = useT();
  const { domain } = useNode();
  const { session, isOwner, controller } = useWhiteboardSession(channelId);
  const [busy, setBusy] = useState(false);
  const othersBoard = !!session && !isOwner;
  if (!canOpen && !isOwner) return null;
  const onClick = async () => {
    setBusy(true);
    try {
      if (isOwner) {
        if (confirm(t("whiteboard.close_confirm"))) await controller.close();
      } else if (!othersBoard) {
        await openBoard(controller, { domain, conversationId: channelId });
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const label = isOwner ? t("whiteboard.control_close") : othersBoard ? t("whiteboard.control_busy") : t("whiteboard.control_open");
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={isOwner}
      disabled={busy || othersBoard}
      onClick={() => void onClick()}
      data-testid="voice-whiteboard"
      className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-lg disabled:opacity-40 ${isOwner ? "bg-accent-soft text-accent" : "text-fg-1 hover:bg-bg-3 hover:text-fg-0"} ${className}`}
    >
      🖍
    </button>
  );
}

/** Small badge next to the owner in the voice channel's sidebar row. */
export function WhiteboardOwnerBadge({ channelId, address }: { channelId: string; address: string }) {
  const t = useT();
  const { session } = useWhiteboardSession(channelId);
  if (!session || session.owner.toLowerCase() !== address.toLowerCase()) return null;
  return (
    <span role="img" className="text-[12px]" title={t("whiteboard.badge")} aria-label={t("whiteboard.badge")} data-testid="whiteboard-owner-badge">
      🖍
    </span>
  );
}
