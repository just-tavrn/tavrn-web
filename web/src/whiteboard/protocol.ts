// SPDX-License-Identifier: Apache-2.0
/**
 * Event types of the whiteboard sync (tavrn-protocol/WHITEBOARD.md §3). Every decrypted payload carries its
 * own `type`, which must equal the type of the ephemeral event it arrived in.
 */
export const WB = {
  /** Owner: the board is open (also the 30-second keepalive); plaintext session state for the node. */
  open: "whiteboard.open",
  /** Owner or moderator: the board is closed for everyone. */
  close: "whiteboard.close",
  /** Owner: "open for everyone" and the granted users changed (plaintext session state for the node). */
  grant: "whiteboard.grant",
  /** Owner: changed elements (and the background). */
  update: "whiteboard.update",
  /** Owner: the whole scene, for late joiners (`to`) or after loading a scene (`replace`). */
  snapshot: "whiteboard.snapshot",
  /** Owner (or a granted editor towards the owner): images referenced by image elements. */
  files: "whiteboard.files",
  /** Granted editor: changed elements, applied and re-broadcast by the owner. */
  propose: "whiteboard.propose",
  /** Joining viewer: please send me a snapshot. */
  request: "whiteboard.request",
  /** Joined viewer: still here (answer to the owner's keepalive). */
  here: "whiteboard.here",
  /** Viewer: left the session. */
  leave: "whiteboard.leave",
  /** Owner: a small image of the board for stage tiles (every few seconds while it changes). */
  thumbnail: "whiteboard.thumbnail",
  /** A part of a payload too large for one event. */
  chunk: "whiteboard.chunk",
  /** Pointer position of a participant. */
  cursor: "cursor",
} as const;

export type WbType = (typeof WB)[keyof typeof WB];

/** The sender of an ephemeral event as the node reports it (and the signature confirms when encrypted). */
export interface Sender {
  user: string;
  device_id: string;
}

export const identityOf = (s: Sender): string => `${s.user}/${s.device_id}`;

/** Intervals and rates of the client (design note 4.10, 9e). */
export const TIMING = {
  /** Element diffs: at most every 50 ms (~20/s). */
  updateMs: 50,
  /** Cursor positions: at most every 100 ms (~10/s). */
  cursorMs: 100,
  /** Thumbnails: at most every 5 s, only after changes. */
  thumbnailMs: 5_000,
  /** Owner keepalive (`whiteboard.open`); the node ends sessions after 90 s of silence. */
  keepaliveMs: 30_000,
  /** Owner: snapshot requests arriving within this window are answered together. */
  snapshotDebounceMs: 300,
  /** Viewer: ask again if no snapshot arrived. */
  requestRetryMs: 5_000,
  /** Cursors of others disappear after this without movement. */
  cursorIdleMs: 5_000,
  /** Owner: participants without a sign of life are dropped after this. */
  participantTimeoutMs: 75_000,
  /** Autosave of the owner's current library scene. */
  autosaveMs: 30_000,
  /** Owner's unsaved board kept in the local encrypted store. */
  draftMs: 5_000,
  /** Events per second the client sends (the node allows 30 per sender). */
  sendPerSecond: 28,
} as const;
