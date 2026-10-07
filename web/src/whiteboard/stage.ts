// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard on the voice stage (design note 4.10 "presented like a stream, joined on demand"): which tile
 * presents the board, what a tile shows, and the rule that one user presents either a screen share or a
 * whiteboard at a time. Pure helpers plus the two guards the voice controls and the board call.
 */
import type { WhiteboardSession } from "@tavrn/sdk";
import { t } from "../i18n";
import { useVoice } from "../voice/store";
import { stopScreenShare } from "../voice/index";
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
 * The stage tile that presents the board: the owner's device in the call (identity `<address>/<device>`),
 * or, when the owner presents from another device, the owner's tile of any device.
 */
export function presenterIdentity(session: Pick<WhiteboardSession, "owner" | "device_id"> | null, identities: readonly string[]): string | null {
  if (!session) return null;
  const owner = session.owner.toLowerCase();
  const exact = identities.find((i) => i.toLowerCase() === `${owner}/${session.device_id.toLowerCase()}`);
  if (exact) return exact;
  return identities.find((i) => i.toLowerCase().startsWith(`${owner}/`)) ?? null;
}

export type TileBoard =
  | { kind: "none" }
  /** This tile presents the board. `self`: it is this device; `canJoin`: show "Join whiteboard session". */
  | { kind: "presenting"; self: boolean; canJoin: boolean; watching: number }
  /** For the owner: this participant joined the board. */
  | { kind: "watching" };

/** What the whiteboard adds to a participant's tile. */
export function tileBoardState(
  tile: { identity: string; self: boolean },
  presenter: string | null,
  view: { joined: boolean; isOwner: boolean; watchers: ReadonlySet<string> | ReadonlyMap<string, unknown> },
): TileBoard {
  if (presenter && tile.identity === presenter) {
    return { kind: "presenting", self: tile.self || view.isOwner, canJoin: !view.joined && !view.isOwner && !tile.self, watching: view.watchers.size };
  }
  if (view.isOwner && view.watchers.has(tile.identity)) return { kind: "watching" };
  return { kind: "none" };
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
  return true;
}
