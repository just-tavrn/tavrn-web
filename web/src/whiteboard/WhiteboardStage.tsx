// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard on the voice stage (design note 4.10; docs/CLIENT.md "Streams are joined"): the board is its own
 * stage tile like a screen share, and the camera tiles stay as they are. Others see a placeholder ("Whiteboard ·
 * <who started it>", the badge, the live thumbnail and **Join whiteboard**; a double-click joins as well); joined, the
 * board fills a large tile with focus, maximize, popout, fullscreen and **Leave whiteboard**, which returns to the
 * placeholder, any number of times. The device that presents gets a preview of its board that it can hide and the
 * "Whiteboard is open" bar with the preview toggle and Close (as the "You are streaming" bar). The voice member list
 * marks the presenter with a small board badge; the call controls open or close a board. Used by
 * `web/src/voice/ui/*` through small additive hooks and components.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { Button } from "../components/ui";
import { EyeOffIcon } from "../components/icons";
import { toastError } from "../stores/toasts";
import { confirmDialog } from "../components/Confirm";
import { ScreenOffIcon } from "../voice/ui/icons";
import { FullscreenButton, FullscreenControls, exitFullscreen, fullscreenElement, useFullscreen } from "../voice/ui/fullscreen";
import { useBoardContent, useWhiteboardSession } from "./store";
import { boardIsWide, boardTileState, openBoard, presenterIdentity, setBoardPreview, useBoardPreview } from "./stage";

/** The stage's view of the channel's board: which tile it is (`stage.ts` `boardTileState`) and who presents it. */
export function useStageBoard(channelId: string, identities: readonly string[]) {
  const wb = useWhiteboardSession(channelId);
  const preview = useBoardPreview((s) => s.shown);
  const key = identities.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const presenter = useMemo(() => presenterIdentity(wb.session, identities), [wb.session, key]);
  return { ...wb, presenter, tile: boardTileState({ session: !!wb.session, isOwner: wb.isOwner, joined: wb.joined, preview }) };
}

/** The board badge of the whiteboard tile and the bar. */
function BoardBadge() {
  const t = useT();
  return (
    <span role="img" className="rounded bg-accent px-1.5 text-[11px] leading-5 text-accent-text" title={t("whiteboard.badge")} aria-label={t("whiteboard.badge")} data-testid="whiteboard-badge">
      🖍
    </span>
  );
}

/**
 * The board before this viewer joins it: badge, "Whiteboard · <name>", the owner's live thumbnail and Join
 * whiteboard (a double-click on the tile joins as well). Nothing of the board but the thumbnail is received.
 */
export function WhiteboardPlaceholder({ channelId, name, color }: { channelId: string; name: string; color?: string | null }) {
  const t = useT();
  const { join, thumbnailUrl } = useWhiteboardSession(channelId);
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border-2 border-line bg-bg-2 p-3" data-testid="whiteboard-tile" data-state="available" onDoubleClick={join}>
      {thumbnailUrl && <img src={thumbnailUrl} alt={t("whiteboard.badge")} className="absolute inset-0 h-full w-full object-contain opacity-70" data-testid="whiteboard-thumbnail" />}
      <div className="absolute inset-x-1.5 top-1.5 flex min-w-0 items-center gap-1.5">
        <BoardBadge />
        <span className="truncate rounded-md bg-black/60 px-1.5 py-0.5 text-xs text-fg-0" data-testid="whiteboard-tile-title">
          {t("whiteboard.title")} · <span style={color ? { color } : undefined}>{name}</span>
        </span>
      </div>
      {!thumbnailUrl && (
        <span className="text-3xl" aria-hidden="true">
          🖍
        </span>
      )}
      <Button className="relative" onClick={join} aria-label={t("whiteboard.tile_join_named", { name })} data-testid="whiteboard-join">
        {t("whiteboard.tile_join")}
      </Button>
    </div>
  );
}

/** The joined board as a large stage tile (lazy: the board UI and Excalidraw load only when a board is shown). */
const WhiteboardStageTile = lazy(() => import("./WhiteboardStageTile"));

const headerButton = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3 hover:text-fg-0";

/**
 * The board in a large stage tile: joined (Leave whiteboard, also in the fullscreen controls) or the owner's own
 * board (Hide preview). Fullscreen as with streams: a touch device turns to landscape for a board wider than tall.
 */
export function WhiteboardLargeTile({ roomId, channelId, name, focused, onFocus, className = "" }: { roomId: string; channelId: string; name: string; focused: boolean; onFocus: () => void; className?: string }) {
  const t = useT();
  const { isOwner, leave, controller } = useWhiteboardSession(channelId);
  const fs = useFullscreen<HTMLDivElement>();
  // Recomputed when the elements change (coalesced, `useBoardContent`).
  const content = useBoardContent(controller);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wide = useMemo(() => boardIsWide(controller.elements.values()), [controller, content]);
  const leaveBoard = () => {
    if (fs.ref.current && fullscreenElement() === fs.ref.current) void exitFullscreen();
    leave();
  };
  const extra = (
    <>
      <FullscreenButton active={fs.active} onToggle={fs.toggle} className="bg-transparent text-fg-1 hover:bg-bg-3" testId="whiteboard-fullscreen" />
      {isOwner ? (
        <button type="button" className={headerButton} onClick={() => setBoardPreview(false)} aria-label={t("voice.stream.preview_hide")} title={t("voice.stream.preview_hide")} data-testid="whiteboard-preview-hide">
          <EyeOffIcon size={16} />
        </button>
      ) : (
        <button type="button" className={headerButton} onClick={leaveBoard} aria-label={t("whiteboard.tile_leave_named", { name })} title={t("whiteboard.tile_leave")} data-testid="whiteboard-leave">
          <ScreenOffIcon size={16} />
        </button>
      )}
    </>
  );
  return (
    <div
      ref={fs.ref}
      className={`relative min-h-0 bg-bg-0 [&:fullscreen]:h-dvh [&:fullscreen]:w-dvw ${className}`}
      data-testid="whiteboard-tile"
      data-state={isOwner ? "preview" : "joined"}
      data-focused={focused || undefined}
      data-wide={String(wide)}
      data-orientation={fs.active ? fs.orientation : undefined}
    >
      <Suspense fallback={null}>
        <WhiteboardStageTile roomId={roomId} channelId={channelId} focused={focused} onFocus={onFocus} headerExtra={extra} />
      </Suspense>
      {fs.active && <FullscreenControls onExit={fs.toggle} onLeaveStream={isOwner ? undefined : leaveBoard} leaveLabel={t("whiteboard.tile_leave")} leaveTestId="fullscreen-board-leave" />}
    </div>
  );
}

/**
 * The presenting device's bar while its board is open: "Whiteboard is open", how many joined, the preview toggle
 * (the preview tile can be hidden and reopened here) and Close (after a confirmation, for everyone).
 */
export function WhiteboardIndicator({ channelId }: { channelId: string }) {
  const t = useT();
  const { session, isOwner, controller } = useWhiteboardSession(channelId);
  const preview = useBoardPreview((s) => s.shown);
  const [busy, setBusy] = useState(false);
  if (!session || !isOwner) return null;
  const close = async () => {
    if (!(await confirmDialog({ title: t("whiteboard.close"), text: t("whiteboard.close_confirm"), confirmLabel: t("whiteboard.close"), danger: true }))) return;
    setBusy(true);
    try {
      await controller.close();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-1 px-2 py-1 text-xs" data-testid="whiteboard-indicator">
      <BoardBadge />
      <span className="font-medium text-fg-0">{t("whiteboard.open_bar")}</span>
      <span className="text-fg-2" data-testid="whiteboard-joined-count">
        {t("whiteboard.joined_count", { count: controller.participants.size })}
      </span>
      <span className="flex-1" />
      <Button variant="ghost" className="min-h-8 px-2 text-xs" onClick={() => setBoardPreview(!preview)} data-testid="whiteboard-preview-toggle">
        {preview ? t("voice.stream.preview_hide") : t("voice.stream.preview_show")}
      </Button>
      <Button variant="danger" className="min-h-8 px-2 text-xs" disabled={busy} onClick={() => void close()} data-testid="whiteboard-stop">
        {t("whiteboard.close")}
      </Button>
    </div>
  );
}

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
        if (await confirmDialog({ title: t("whiteboard.close"), text: t("whiteboard.close_confirm"), confirmLabel: t("whiteboard.close"), danger: true })) await controller.close();
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

/** The small board badge next to LIVE in the voice member list, on the member who presents the board. */
export function WhiteboardRowBadge() {
  const t = useT();
  return (
    <span role="img" className="text-[12px]" title={t("whiteboard.badge")} aria-label={t("whiteboard.badge")} data-testid="whiteboard-owner-badge">
      🖍
    </span>
  );
}
