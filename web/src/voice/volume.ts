// SPDX-License-Identifier: Apache-2.0
/**
 * Playback volumes of a remote participant (issue #20): the voice (microphone) and the stream (screen share
 * audio) are separate sources. Pure, so the rules are tested without LiveKit; `session.ts` applies them with
 * `RemoteParticipant.setVolume` per source. The ducking of the priority speaker is a separate gain in front of
 * these volumes and multiplies with them (`priority.ts`).
 *
 * - voice  = per-person voice volume × output volume, 0 while deafened
 * - stream = per-streamer stream volume × output volume; while deafened 0, unless the user is watching the
 *            stream and "stream audio while deafened" is on (the default)
 */
import type { VoiceSettings } from "./settings";

export interface VolumeInput {
  deafened: boolean;
  /** Per-person voice volume in percent (0–200). */
  voice: number;
  /** Per-streamer stream volume in percent (0–200). */
  stream: number;
  /** Output volume of the settings in percent (0–200). */
  output: number;
  /** The stream is on screen (its tile is shown). */
  watched: boolean;
  /** Settings switch: a watched stream stays audible while deafened. */
  streamWhileDeafened: boolean;
}

/** Gains (1 = unchanged) of a participant's microphone and stream audio. */
export interface Volumes {
  microphone: number;
  stream: number;
}

export function playbackVolumes(i: VolumeInput): Volumes {
  const output = i.output / 100;
  const streamAudible = !i.deafened || (i.watched && i.streamWhileDeafened);
  return {
    microphone: i.deafened ? 0 : (i.voice / 100) * output,
    stream: streamAudible ? (i.stream / 100) * output : 0,
  };
}

/** The volumes of the user `address` (without device) from the settings. */
export function participantVolumes(s: VoiceSettings, address: string, state: { deafened: boolean; watched: boolean }): Volumes {
  return playbackVolumes({
    deafened: state.deafened,
    voice: s.userVolumes[address] ?? 100,
    stream: s.streamVolumes[address] ?? 100,
    output: s.outputVolume,
    watched: state.watched,
    streamWhileDeafened: s.streamWhileDeafened,
  });
}
