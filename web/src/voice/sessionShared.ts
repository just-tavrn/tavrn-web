// SPDX-License-Identifier: Apache-2.0
/**
 * What both voice engines (`engine.ts`) share around the media: the node routes of a voice channel or a call (VOICE.md
 * §3, §11), the join answer they use, and the notification sounds for the other participants' changes. No LiveKit
 * import: the native engine (`nativeSession.ts`) loads it without livekit-client.
 */
import type { TavrnApi, VoiceJoin, VoiceParticipant, VoiceStatePatch } from "@tavrn/sdk";
import type { MlsManager } from "@tavrn/e2ee";
import { participantsOf, useVoicePresence } from "./presence";
import type { Cue } from "./cues";
import type { VoiceTarget } from "./store";

/** What the session needs from a voice channel join or a call join (`VoiceJoin`, `CallJoin`). */
export type JoinInfo = Pick<VoiceJoin, "url" | "token" | "epoch" | "limits" | "reconnect_grace_secs" | "participants"> & { ice_aliases?: string[] };

/** The node routes of the target: a voice channel or a call (VOICE.md §3, §11). */
export interface Endpoints {
  join: (start: boolean) => Promise<JoinInfo>;
  leave: () => Promise<unknown>;
  updateState: (patch: VoiceStatePatch) => Promise<unknown>;
  /** This device's screen publisher (VOICE.md §4b, the Android app): its join and its leave. */
  joinScreen: () => Promise<JoinInfo>;
  leaveScreen: () => Promise<unknown>;
}

export function endpoints(api: TavrnApi, target: VoiceTarget): Endpoints {
  if (target.call) {
    const id = target.channelId;
    return {
      join: (start) => (start ? api.calls.start(id) : api.calls.join(id)),
      leave: () => api.calls.leave(id),
      updateState: (patch) => api.calls.updateState(id, patch),
      joinScreen: () => api.calls.join(id, "screen"),
      leaveScreen: () => api.calls.leave(id, "screen"),
    };
  }
  return {
    join: () => api.voice.join(target.roomId, target.channelId),
    leave: () => api.voice.leave(target.roomId, target.channelId),
    updateState: (patch) => api.voice.updateState(target.roomId, target.channelId, patch),
    joinScreen: () => api.voice.join(target.roomId, target.channelId, "screen"),
    leaveScreen: () => api.voice.leave(target.roomId, target.channelId, "screen"),
  };
}

/**
 * Plays the cues for changes of the other participants of the call (from `voice.state`): `self` is this device's
 * identity, `live` whether the session is still the current one. Returns the unsubscriber.
 */
export function followOthers(target: VoiceTarget, key: string, self: () => string, live: () => boolean, cue: (c: Cue, own: boolean) => void): () => void {
  const index = (list: VoiceParticipant[]) => new Map(list.filter((p) => p.identity !== self()).map((p) => [p.identity, p]));
  const domainLength = target.domain.length + 1;
  let before = index(participantsOf(useVoicePresence.getState(), target.domain, key.slice(domainLength)));
  return useVoicePresence.subscribe((now, prev) => {
    if (now.channels[key] === prev.channels[key] || !live()) return;
    const after = index(participantsOf(now, target.domain, key.slice(domainLength)));
    for (const [id, p] of after) {
      const old = before.get(id);
      if (!old) cue("join", false);
      else if (old.connection !== p.connection) cue(p.connection === "reconnecting" ? "connection_lost" : "connection_restored", false);
      else if ((!old.streaming && p.streaming) || (!old.camera && p.camera)) cue("stream_on", false);
      else if ((old.streaming && !p.streaming) || (old.camera && !p.camera)) cue("stream_off", false);
    }
    for (const id of before.keys()) if (!after.has(id)) cue("leave", false);
    before = after;
  });
}

/**
 * Catches the channel's group up when the node's epoch (from `voice.state`) is ahead of this device's: a commit
 * event may still be on the way, the catch-up re-keys. One catch-up at a time: presence updates while one runs only
 * ask for a check once it settled (each catch-up fetches the handshake log). Returns the unsubscriber.
 */
export function followEpoch(key: string, q: string, mls: Pick<MlsManager, "epoch" | "catchUp">): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const epoch = useVoicePresence.getState().epochs[key];
    const local = mls.epoch(q);
    if (epoch == null || local == null || epoch <= local) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void mls
      .catchUp(q)
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (!again) return;
        again = false;
        check();
      });
  };
  const off = useVoicePresence.subscribe(check);
  return () => {
    stopped = true;
    off();
  };
}
