// SPDX-License-Identifier: Apache-2.0
/**
 * The start of a voice session (VOICE.md §4, ENCRYPTION.md §4.7, §5a), as parallel as the protocol allows; shared by
 * both engines (`session.ts`, `nativeSession.ts`). Light module: no LiveKit import.
 *
 * Order of a join:
 *
 * 1. At the click the media of the session start (the microphone pipeline, the playback context and LiveKit's E2EE
 *    worker, `session.ts`), and the node's pending removals are requested while this device joins the channel's MLS
 *    group (`ensureJoined`).
 * 2. Once this device is in the group, `voice/join` goes out. Meanwhile the ghost cleanup runs (never waiting for the
 *    election, `cleanupBeforeVoice`) and then the self update that gives the session its fresh epoch.
 * 3. Only the frame key of the fresh epoch and publishing wait for that (`fresh`): the call connects meanwhile with
 *    the key of the current epoch, and the re-key subscription of the session picks up the new epoch. Nothing is
 *    published before the fresh key is the sending key.
 *
 * Failures: a group that cannot be joined or a refused `voice/join` release the media (no seat was taken). Every later
 * failure (the catch-up to the node's epoch, the frame key, the connection) frees the seat and releases the media
 * (`abandon`); a rejoin after a dropped connection keeps the seat the node holds for the grace period.
 */
import type { MlsManager, PendingRemovalLike } from "@tavrn/e2ee";
import { VoiceError } from "./errors";
import type { JoinInfo } from "./sessionShared";

/** What a join needs from the session manager. */
export type JoinMls = Pick<MlsManager, "ensureJoined" | "selfUpdate" | "epoch" | "catchUp">;

/** Something started at the click that a failed join gives back (idempotent). */
export interface Releasable {
  release(): Promise<void>;
}

export interface JoinFlowDeps {
  mls: JoinMls;
  /** Qualified id of the channel's (or call's) conversation. */
  q: string;
  canCreate: boolean;
  /** A rejoin after a dropped connection: no cleanup, no self update (the session goes on in its epoch), the seat stays. */
  rejoin: boolean;
  /** `voice/join` (or the call's join), with the entitlement caps applied. */
  join(): Promise<JoinInfo>;
  /** Frees the seat (`voice/leave`). */
  leave(): Promise<unknown>;
  /** The node's pending removals of the conversation (`loadPending`). */
  pending(): Promise<PendingRemovalLike[]>;
  /** The join's ghost cleanup (`cleanupBeforeVoice`): resolves with the background run to start once connected. */
  cleanup(pending: Promise<PendingRemovalLike[]>): Promise<() => void>;
  /** The media started at the click. */
  media?: Releasable;
  /** Stage marks of the join timings (`joinTimings.ts`). */
  mark?(stage: string, detail?: Record<string, unknown>): void;
}

export interface JoinFlow {
  /** The node's answer to `voice/join`. */
  info: JoinInfo;
  /**
   * Resolves once the session's fresh epoch is in place (cleanup and self update, both best effort) and the group
   * caught up with the epoch of the node's answer; rejects when that catch-up fails.
   */
  fresh: Promise<void>;
  /** Starts a postponed ghost cleanup in the background (call once connected); nothing otherwise. */
  cleanupLater(): void;
  /** After a failure: frees the seat (not on a rejoin) and releases the media. */
  abandon(): Promise<void>;
}

/** Runs steps 1 and 2 above; resolves with the node's answer while the self update may still run. */
export async function startJoin(d: JoinFlowDeps): Promise<JoinFlow> {
  const mark = d.mark ?? (() => undefined);
  try {
    // Requested while the group is joined (one round trip less before voice/join).
    const pending = d.rejoin ? null : d.pending().catch(() => []);
    mark("ensure_joined_start", { epoch: d.mls.epoch(d.q) });
    if ((await d.mls.ensureJoined(d.q, { canCreate: d.canCreate })) === "no_group") throw new VoiceError("no_group");
    mark("ensure_joined_done", { epoch: d.mls.epoch(d.q) });
    mark("voice_join_sent");
    const answer = d.join();
    let later: () => void = () => undefined;
    // Ghost leaves go before the fresh voice key (ENCRYPTION.md §4.7), then the self update (§5a). Never rejects.
    const update = pending
      ? (async () => {
          mark("cleanup_start");
          later = await d.cleanup(pending).catch(() => () => undefined);
          mark("cleanup_done");
          await d.mls.selfUpdate(d.q).catch(() => false);
          mark("self_update_done", { epoch: d.mls.epoch(d.q) });
        })()
      : Promise.resolve();
    const info = await answer;
    mark("voice_join_response", { epoch: info.epoch, participants: info.participants.length });
    const fresh = update.then(async () => {
      // Commits this device has not seen yet (the node's epoch is ahead): the frame key must be the group's current one.
      if (info.epoch != null && (d.mls.epoch(d.q) ?? -1) < info.epoch) {
        await d.mls.catchUp(d.q);
        mark("catch_up_done", { epoch: d.mls.epoch(d.q) });
      }
    });
    // Awaited by the session; a rejection before that is not an unhandled one.
    fresh.catch(() => undefined);
    let abandoned = false;
    return {
      info,
      fresh,
      cleanupLater: () => later(),
      abandon: async () => {
        if (abandoned) return;
        abandoned = true;
        await d.media?.release();
        if (!d.rejoin) await d.leave().catch(() => undefined);
      },
    };
  } catch (e) {
    await d.media?.release();
    throw e;
  }
}

/** The microphone pipeline started at the click (`EarlyPipeline.take` hands it over, `release` gives it back). */
export interface EarlyPipeline<P> extends Releasable {
  /** The pipeline in the music mode the node's answer asks for; reopened when the early guess was wrong. */
  take(music: boolean): Promise<P>;
}

/**
 * Starts `create(guess)` at once. The music mode (two channels, no processing, VOICE.md §4a) depends on the channel's
 * bitrate in the node's answer: the caller guesses it from the last join of the channel (speech otherwise), and a
 * wrong guess closes the early pipeline and opens the right one. After `take` the pipeline belongs to the caller;
 * `release` closes one that was not taken (and is harmless after it was).
 */
export function earlyPipeline<P extends { close(): Promise<void> }>(create: (music: boolean) => Promise<P>, guess: boolean): EarlyPipeline<P> {
  const first = create(guess);
  // A failure surfaces in `take`; until then it is not an unhandled rejection.
  first.catch(() => undefined);
  let taken: Promise<P> | null = null;
  let released = false;
  return {
    take(music) {
      if (released) return Promise.reject(new VoiceError("connect_failed"));
      if (!taken) {
        taken =
          music === guess
            ? first
            : first.then(
                (p) => p.close().then(() => create(music)),
                () => create(music),
              );
      }
      return taken;
    },
    async release() {
      if (released) return;
      released = true;
      if (taken) return;
      await first.then((p) => p.close()).catch(() => undefined);
    },
  };
}

/** How long a background leave of the previous channel may take before it is given up (logged). */
export const LEAVE_BOUND_MS = 5_000;

/**
 * The node's leave of the previous channel when switching channels (VOICE.md §3): it runs in the background while the
 * next channel is joined, instead of before it. The node already ends the earlier participation of this user when
 * the new join arrives (one voice session per user), so the leave only tidies up. Bounded and logged; a join of the
 * same channel waits for its leave, which would otherwise end the new participation.
 */
export class BackgroundLeaves {
  private readonly byKey = new Map<string, Promise<void>>();

  constructor(private readonly boundMs = LEAVE_BOUND_MS) {}

  start(key: string, leave: () => Promise<unknown>): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`voice: leaving the previous channel took longer than ${this.boundMs} ms, not waiting any longer`);
        resolve();
      }, this.boundMs);
    });
    const done = leave().then(
      () => undefined,
      (e: unknown) => console.warn("voice: leaving the previous channel failed", e),
    );
    const p: Promise<void> = Promise.race([done, bound]).finally(() => {
      clearTimeout(timer);
      if (this.byKey.get(key) === p) this.byKey.delete(key);
    });
    this.byKey.set(key, p);
  }

  /** Resolves once no leave of `key` is on its way any more. */
  async settled(key: string): Promise<void> {
    await this.byKey.get(key);
  }
}
