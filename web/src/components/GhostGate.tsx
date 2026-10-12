// SPDX-License-Identifier: Apache-2.0
/**
 * The ghost member gate of every encrypted write path (ENCRYPTION.md §4.6): messages, edits, thread titles, forum
 * posts, file records and whiteboard scenes. While the roster holds a ghost leaf the user has not acknowledged, the
 * view shows the warning and does not send; acknowledging tells the session manager (`acknowledgeGhosts`), which
 * refuses content on its own as well, so a view without this gate fails closed instead of sending to the ghost.
 */
import type { ReactNode } from "react";
import type { GhostViolation, MlsManager } from "@tavrn/e2ee";
import { useLabelledGhosts } from "../lib/leafCleanup";
import { useMlsUi } from "../stores/mls";
import { GhostWarning } from "./E2eeNotices";

export interface GhostGate {
  /** A ghost the user has not acknowledged: nothing may be encrypted here. */
  blocked: boolean;
  /** The warning with its "continue anyway" button (null outside encrypted conversations). */
  warning: ReactNode;
  acknowledge: () => Promise<void>;
}

/** The view state's name of one acknowledged leaf: identity and signature key (a new key under the same id warns again). */
export const ghostAckId = (g: Pick<GhostViolation, "identity" | "key">) => `${g.identity}|${g.key}`;

/** Acknowledges the ghosts shown for `q` (qualified id), leaf by leaf, in the session manager and in the view state. */
export async function acknowledgeGhosts(q: string, mls: MlsManager | null, ghosts: GhostViolation[]): Promise<void> {
  await mls?.acknowledgeGhosts(q, ghosts.map((g) => ({ identity: g.identity, key: g.key })));
  const ids = ghosts.map(ghostAckId);
  useMlsUi.setState((s) => ({ ghostAck: { ...s.ghostAck, [q]: [...new Set([...(s.ghostAck[q] ?? []), ...ids])] } }));
}

export { isGhostRefusal } from "../lib/leafCleanup";

/** After a refusal: the view shows the warning again (a device joined that nobody was shown yet). */
export function forgetGhostAck(q: string): void {
  useMlsUi.setState((s) => {
    const ghostAck = { ...s.ghostAck };
    delete ghostAck[q];
    return { ghostAck };
  });
}

export function useGhostGate(q: string, e2ee: { ghosts: GhostViolation[]; mls: MlsManager | null }, encrypted: boolean): GhostGate {
  const acked = useMlsUi((s) => s.ghostAck[q]);
  const labelled = useLabelledGhosts(q, e2ee.ghosts);
  const open = encrypted ? e2ee.ghosts.filter((g) => !acked?.includes(ghostAckId(g))) : [];
  const acknowledge = () => acknowledgeGhosts(q, e2ee.mls, e2ee.ghosts);
  return {
    blocked: open.length > 0,
    warning: encrypted ? <GhostWarning ghosts={labelled} acknowledged={open.length === 0} onAcknowledge={() => void acknowledge()} /> : null,
    acknowledge,
  };
}
