// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard on the voice stage (design note 4.10 "presented like a stream, joined on demand"; docs/CLIENT.md
 * "Streams are joined"): the board is its own stage tile like a screen share (a placeholder until joined, the board
 * once joined, the owner's hideable preview), the member list joins it from the owner's row, and one user presents
 * either a screen share or a whiteboard at a time. Pure helpers plus the two guards the voice controls and the
 * board call.
 */
import type { WhiteboardSession } from "@tavrn/sdk";
import { create } from "zustand";
import { t } from "../i18n";
import { useVoice } from "../voice/store";
import { stopScreenShare } from "../voice/index";
import { rowStreamAction, type RowStreamAction } from "../voice/streams";
import { loadDraft, ownedBoards, type BoardContext } from "./store";
import type { WhiteboardController } from "./controller";

export type Presentation = "screen" | "board";

/**
 * What has to stop before `want` can start: a user presents one thing at a time. Null when nothing is in
 * the way (or `want` is already running).
 */
export function presentationConflict(want: Presentation, running: { screen: boolean; board: boolean }): Presentation | null {
  if (want === "screen") return running.board ? "board" : null;
  return running.screen ? "screen" : null;
}

/**
 * The participant who presents the board (the member list's board badge): the owner's device in the call (identity
 * `<address>/<device>`), or, when the owner presents from another device, the owner's participation of any device.
 */
export function presenterIdentity(session: Pick<WhiteboardSession, "owner" | "device_id"> | null, identities: readonly string[]): string | null {
  if (!session) return null;
  const owner = session.owner.toLowerCase();
  const exact = identities.find((i) => i.toLowerCase() === `${owner}/${session.device_id.toLowerCase()}`);
  if (exact) return exact;
  return identities.find((i) => i.toLowerCase().startsWith(`${owner}/`)) ?? null;
}

/**
 * The owner's preview of the own board on the stage: shown when a board opens, hideable like the own screen share's
 * preview (the "Whiteboard is open" bar and a double-click on the own row in the member list bring it back).
 */
export const useBoardPreview = create<{ shown: boolean }>(() => ({ shown: true }));
export const setBoardPreview = (shown: boolean) => useBoardPreview.setState({ shown });

/**
 * The whiteboard's stage tile: `available` the placeholder with "Join whiteboard", `joined` the board in a large tile,
 * `preview` the owner's own board, `hidden` the owner hid it, `none` no board in the channel.
 */
export type BoardTile = "none" | "available" | "joined" | "preview" | "hidden";

export function boardTileState(view: { session: boolean; isOwner: boolean; joined: boolean; preview: boolean }): BoardTile {
  if (!view.session) return "none";
  if (view.isOwner) return view.preview ? "preview" : "hidden";
  return view.joined ? "joined" : "available";
}

/**
 * Whether the board's content is wider than tall (the bounding box of its elements; an empty board fills a 16:9
 * tile): in fullscreen a touch device turns to landscape for it, as for a wide stream.
 */
export function boardIsWide(elements: Iterable<{ x?: unknown; y?: unknown; width?: unknown; height?: unknown; isDeleted?: boolean }>): boolean {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    if (e.isDeleted) continue;
    const [x, y, w, h] = [num(e.x), num(e.y), num(e.width), num(e.height)];
    const [x0, x1] = w < 0 ? [x + w, x] : [x, x + w];
    const [y0, y1] = h < 0 ? [y + h, y] : [y, y + h];
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y1);
  }
  if (minX === Infinity) return true;
  return maxX - minX >= maxY - minY;
}

/**
 * A double-click (or Enter) on the member who presents the board: joins it while this device is in that same voice
 * channel (otherwise a hint), the own row of the presenting device shows the hidden preview again; members without
 * a board: nothing. The same rule as a streaming member's row.
 */
export function rowBoardAction(member: { identity: string; presenting: boolean }, viewer: Parameters<typeof rowStreamAction>[1], channel: { domain: string; channelId: string }): RowStreamAction {
  return rowStreamAction({ identity: member.identity, streaming: member.presenting }, viewer, channel);
}

/** Before a screen share: a board this device presents is closed (after confirmation). `false`: cancelled. */
export async function beforeScreenShare(confirmFn: (message: string) => boolean = (m) => confirm(m)): Promise<boolean> {
  const boards = ownedBoards();
  if (!presentationConflict("screen", { screen: useVoice.getState().screen, board: boards.length > 0 })) return true;
  if (!confirmFn(t("whiteboard.stop_board_for_screen"))) return false;
  for (const c of boards) await c.close();
  return true;
}

/** Before presenting a board: a running screen share is stopped (after confirmation). `false`: cancelled. */
export async function beforeBoard(confirmFn: (message: string) => boolean = (m) => confirm(m)): Promise<boolean> {
  if (!presentationConflict("board", { screen: useVoice.getState().screen, board: false })) return true;
  if (!confirmFn(t("whiteboard.stop_screen_for_board"))) return false;
  await stopScreenShare();
  return true;
}

/** Opens a board on this device (continuing the local draft), after the either/or check. */
export async function openBoard(c: WhiteboardController, ctx: Pick<BoardContext, "domain" | "conversationId">): Promise<boolean> {
  if (!(await beforeBoard())) return false;
  const draft = await loadDraft(ctx.domain, ctx.conversationId);
  await c.open(draft ?? undefined);
  setBoardPreview(true);
  return true;
}
