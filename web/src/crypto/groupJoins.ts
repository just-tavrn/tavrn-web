// SPDX-License-Identifier: Apache-2.0
/**
 * Proactive MLS group joins (ENCRYPTION.md §7b): when a room is loaded, this device joins the groups of the room's
 * encrypted channels (the room detail lists only channels the user may view), not only when a channel is opened.
 * Messages posted between the user's room join and the device's first leaf can only be read with keys other members
 * share; joining early keeps that gap small. One join at a time with a pause in between, so a room with many channels
 * does not storm the node; a group is never created here, and a channel whose join did not happen (no group yet, no
 * access) is asked again only after an interval. While a voice join's MLS work runs (`holdGroupJoins`) no probe starts:
 * the join's own operations go first (they also run in the MLS manager's priority lane).
 */
import { qualify, type MlsManager } from "@tavrn/e2ee";
import type { Channel } from "@tavrn/sdk";
import { getMls } from "../stores/mls";

/** Channel kinds with encrypted content (voice channels store none, the welcome channel is plaintext). */
export const JOINABLE_KINDS: ReadonlySet<string> = new Set(["text", "announcement", "forum", "files"]);
/** Pause between two joins. */
export const JOIN_PAUSE_MS = 400;
/** A channel whose join did not happen is asked again after this long. */
export const JOIN_RETRY_MS = 5 * 60_000;

export interface GroupJoinerDeps {
  mls: () => Promise<MlsManager | null>;
  pauseMs?: number;
  retryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves when no voice join holds the probes (`groupJoinsHeld`). */
  held?: () => Promise<void>;
}

export interface GroupJoiner {
  /** Queues the joinable channels of a room on node `domain`; resolves when the queue is empty. */
  enqueue(domain: string, channels: Pick<Channel, "id" | "kind" | "encrypted">[]): Promise<void>;
  /** Sign-out, lock or another account: forget the queue and the attempts. */
  reset(): void;
}

export function createGroupJoiner(deps: GroupJoinerDeps): GroupJoiner {
  const pause = deps.pauseMs ?? JOIN_PAUSE_MS;
  const retry = deps.retryMs ?? JOIN_RETRY_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const queue: string[] = [];
  const queued = new Set<string>();
  /** Conversation → time of its last attempt that did not end in the group. */
  const tried = new Map<string, number>();
  let running: Promise<void> | null = null;
  let generation = 0;

  async function drain(gen: number) {
    let joins = 0;
    while (queue.length && gen === generation) {
      const q = queue.shift()!;
      queued.delete(q);
      const mls = await deps.mls();
      if (gen !== generation) return;
      if (!mls) {
        // Locked: nothing to do now, the next load asks again.
        queue.length = 0;
        queued.clear();
        return;
      }
      if (mls.hasGroup(q)) continue;
      if (joins++ > 0) await sleep(pause);
      await deps.held?.();
      if (gen !== generation) return;
      if (mls.hasGroup(q)) continue;
      try {
        if ((await mls.ensureJoined(q, { canCreate: false })) !== "joined") tried.set(q, now());
      } catch {
        tried.set(q, now());
      }
    }
  }

  return {
    enqueue(domain, channels) {
      for (const c of channels) {
        if (!c.encrypted || !JOINABLE_KINDS.has(c.kind)) continue;
        const q = qualify(domain, c.id);
        const last = tried.get(q);
        if (queued.has(q) || (last !== undefined && now() - last < retry)) continue;
        queue.push(q);
        queued.add(q);
      }
      if (!running && queue.length) {
        const run: Promise<void> = drain(generation).finally(() => {
          if (running === run) running = null;
        });
        running = run;
      }
      return running ?? Promise.resolve();
    },
    reset() {
      generation++;
      queue.length = 0;
      queued.clear();
      tried.clear();
      running = null;
    },
  };
}

/** Voice joins whose MLS work is running (the probes wait for them). */
const holds = new Set<Promise<void>>();

/** A voice join's MLS work runs until `until` settles (either way): the probes wait meanwhile. */
export function holdGroupJoins(until: Promise<unknown>): void {
  const p: Promise<void> = until.then(
    () => undefined,
    () => undefined,
  );
  holds.add(p);
  void p.then(() => holds.delete(p));
}

/** Resolves once no voice join holds the probes. */
export async function groupJoinsHeld(): Promise<void> {
  while (holds.size) await Promise.all(holds);
}

const joiner = createGroupJoiner({ mls: () => getMls(), held: groupJoinsHeld });

/** A room was loaded: join the groups of its encrypted channels in the background (best effort). */
export function joinRoomGroups(domain: string, channels: Pick<Channel, "id" | "kind" | "encrypted">[]): void {
  void joiner.enqueue(domain, channels).catch(() => undefined);
}

/** Sign-out or lock: stop and forget. */
export function resetGroupJoins(): void {
  joiner.reset();
}
