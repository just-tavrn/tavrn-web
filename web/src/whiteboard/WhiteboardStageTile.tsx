// SPDX-License-Identifier: Apache-2.0
/**
 * The joined board as a large stage tile (loaded lazily by `WhiteboardStage.tsx`, inside `WhiteboardLargeTile`, which
 * adds fullscreen and Leave whiteboard / Hide preview as `headerExtra`): the board with its tools, plus focus (the
 * board takes the stage), maximize (full window) and popout (the full-screen route in a new window, for viewers; the
 * presenter keeps presenting from this window).
 */
import { useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { useNode } from "../components/NodeScope";
import { useWhiteboardSession } from "./store";
import { useChannelBoard } from "./WhiteboardPage";
import { WhiteboardSession } from "./WhiteboardSession";
import { platform } from "../platform";

const iconButton = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-fg-1 hover:bg-bg-3 hover:text-fg-0";

/**
 * The joined board as a large stage tile: the board with its tools, plus focus (the board takes the stage),
 * maximize (full window) and popout (the full-screen route in a new window, for viewers).
 */
export default function WhiteboardStageTile({ roomId, channelId, focused, onFocus, headerExtra }: { roomId: string; channelId: string; focused: boolean; onFocus: () => void; headerExtra?: ReactNode }) {
  const t = useT();
  const { roomPath } = useNode();
  const board = useChannelBoard(roomId, channelId);
  const { isOwner } = useWhiteboardSession(channelId);
  const [maximized, setMaximized] = useState(false);
  if (!board.props) return null;
  const popout = () => {
    window.open(`${location.origin}${roomPath(roomId, channelId)}/whiteboard`, "_blank", "popup=yes,width=1280,height=800");
  };
  const start = (
    <div className="flex items-center gap-0.5">
      <button type="button" className={iconButton} onClick={onFocus} aria-label={focused ? t("voice.unfocus") : t("voice.focus")} title={focused ? t("voice.unfocus") : t("voice.focus")} data-testid="whiteboard-focus" aria-pressed={focused}>
        ⤢
      </button>
      <button type="button" className={iconButton} onClick={() => setMaximized((m) => !m)} aria-label={maximized ? t("whiteboard.restore") : t("whiteboard.maximize")} title={maximized ? t("whiteboard.restore") : t("whiteboard.maximize")} data-testid="whiteboard-maximize" aria-pressed={maximized}>
        {maximized ? "🗗" : "🗖"}
      </button>
      {/* The desktop app opens no second window (docs/DESKTOP.md); maximize covers it there. */}
      {!isOwner && !platform().isDesktop && (
        <button type="button" className={iconButton} onClick={popout} aria-label={t("whiteboard.popout")} title={t("whiteboard.popout")} data-testid="whiteboard-popout">
          ↗
        </button>
      )}
      {headerExtra}
    </div>
  );
  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-xl border-2 border-accent/60" data-testid="whiteboard-stage-tile" data-focused={focused || undefined} data-maximized={maximized || undefined}>
      <WhiteboardSession {...board.props} layout={maximized ? "fullscreen" : "embedded"} headerStart={start} />
    </div>
  );
}

