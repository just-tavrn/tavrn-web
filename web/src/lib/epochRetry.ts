// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted content is accepted only under the group's current epoch, or the previous one shortly after its commit
 * (ENCRYPTION.md §5.3). When the node answers `409 mls.epoch_stale`, the commits that moved the group on are processed
 * and the content is encrypted and sent again, once.
 */
import { TavrnApiError } from "@tavrn/sdk";

export function isEpochStale(e: unknown): boolean {
  return e instanceof TavrnApiError && e.code === "mls.epoch_stale";
}

/** Runs `attempt` (encrypt and send); on `mls.epoch_stale` catches up and runs it once more. */
export async function withFreshEpoch<T>(mls: { catchUp(q: string): Promise<void> } | null, q: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!mls || !isEpochStale(e)) throw e;
    await mls.catchUp(q);
    return attempt();
  }
}
