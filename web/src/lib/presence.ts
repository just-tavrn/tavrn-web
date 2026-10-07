// SPDX-License-Identifier: Apache-2.0
/**
 * Presence across nodes (design note 4.9, PROTOCOL.md §6): nodes never forward presence to each other, so
 * the client pushes its state to every node it has a session on (home node and federated sessions) and
 * asks each of them whom it may see. The home node keeps the chosen status and custom status; the
 * others get a copy whenever it changes or a session is opened.
 */
import type { Activity, CustomStatus, MyPresence, PresenceRequest, TavrnApi } from "@tavrn/sdk";
import { api } from "./api";
import { apiFor, useNodes } from "../stores/nodes";
import { usePresence } from "../stores/presence";

/** Every client the presence goes to: the home node first. */
export function presenceTargets(): TavrnApi[] {
  return [api, ...Object.keys(useNodes.getState().sessions).map((d) => apiFor(d))];
}

/** Sends a presence change to every node; the home node's answer becomes the own presence. */
export async function pushPresence(req: PresenceRequest, targets: TavrnApi[] = presenceTargets()): Promise<MyPresence | null> {
  const [home, ...others] = targets;
  const mine = home ? await home.presence.set(req) : null;
  if (mine) usePresence.getState().setMine(mine);
  await Promise.all(others.map((c) => c.presence.set(req).catch(() => undefined)));
  return mine;
}

export async function pushActivity(activity: Activity | null, targets: TavrnApi[] = presenceTargets()): Promise<void> {
  const [home, ...others] = targets;
  const send = (c: TavrnApi) => (activity ? c.presence.setActivity(activity) : c.presence.clearActivity());
  if (home) usePresence.getState().setMine(await send(home));
  await Promise.all(others.map((c) => send(c).catch(() => undefined)));
}

/**
 * Brings the nodes in line with the home node's state (start, new federated session) and loads the
 * presences each node shows. The automatic `idle` of this device is sent as well.
 */
export async function syncPresence(targets: TavrnApi[] = presenceTargets()): Promise<void> {
  const [home, ...others] = targets;
  if (!home) return;
  const mine = await home.presence.mine();
  usePresence.getState().setMine(mine);
  const idle = usePresence.getState().autoIdle;
  const copy: PresenceRequest = { status: idle ? "idle" : mine.status, custom_status: (mine.custom_status ?? null) as CustomStatus | null };
  if (idle) await home.presence.set({ status: "idle" }).catch(() => undefined);
  await Promise.all(
    others.map(async (c) => {
      await c.presence.set(copy).catch(() => undefined);
      if (mine.activity) await c.presence.setActivity(mine.activity).catch(() => undefined);
    }),
  );
  const lists = await Promise.all(targets.map((c) => c.presence.list().catch(() => [])));
  usePresence.getState().seed(lists.flat());
}

/** The device went idle (only while the chosen status is `online`) or became active again. */
export async function setAutoIdle(idle: boolean): Promise<void> {
  const state = usePresence.getState();
  if (idle) {
    if (state.mine && state.mine.status !== "online") return;
    state.setAutoIdle(true);
    await pushPresence({ status: "idle" }).catch(() => undefined);
  } else if (state.autoIdle) {
    state.setAutoIdle(false);
    await pushPresence({ status: "online" }).catch(() => undefined);
  }
}
