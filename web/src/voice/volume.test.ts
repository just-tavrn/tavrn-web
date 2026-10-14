// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type VoiceSettings } from "./settings";
import { participantVolumes, playbackVolumes } from "./volume";

describe("playback volumes: voice and stream audio apart (issue #20)", () => {
  const base = { deafened: false, voice: 100, stream: 100, output: 100, watched: false, streamWhileDeafened: true };

  it("voice volume applies to the microphone only, stream volume to the stream audio only", () => {
    expect(playbackVolumes({ ...base, voice: 50 })).toEqual({ microphone: 0.5, stream: 1 });
    expect(playbackVolumes({ ...base, stream: 150 })).toEqual({ microphone: 1, stream: 1.5 });
    expect(playbackVolumes({ ...base, voice: 0, stream: 200 })).toEqual({ microphone: 0, stream: 2 });
  });

  it("the output volume multiplies with both", () => {
    expect(playbackVolumes({ ...base, voice: 50, stream: 200, output: 50 })).toEqual({ microphone: 0.25, stream: 1 });
    expect(playbackVolumes({ ...base, output: 0 })).toEqual({ microphone: 0, stream: 0 });
    expect(playbackVolumes({ ...base, voice: 200, stream: 200, output: 200 })).toEqual({ microphone: 4, stream: 4 });
  });

  it("every combination of deafened × voice × stream × output × watched × switch", () => {
    for (const deafened of [false, true])
      for (const voice of [0, 50, 100, 200])
        for (const stream of [0, 50, 100, 200])
          for (const output of [0, 50, 100, 200])
            for (const watched of [false, true])
              for (const streamWhileDeafened of [false, true]) {
                const v = playbackVolumes({ deafened, voice, stream, output, watched, streamWhileDeafened });
                const label = JSON.stringify({ deafened, voice, stream, output, watched, streamWhileDeafened });
                // Deafened: no voices, whatever the volumes.
                expect(v.microphone, label).toBeCloseTo(deafened ? 0 : (voice / 100) * (output / 100));
                // A watched stream stays audible while deafened (switch on); otherwise deafen silences it.
                const audible = !deafened || (watched && streamWhileDeafened);
                expect(v.stream, label).toBeCloseTo(audible ? (stream / 100) * (output / 100) : 0);
              }
  });

  it("an unwatched stream goes silent while deafened, a watched one only with the switch off", () => {
    expect(playbackVolumes({ ...base, deafened: true, watched: false }).stream).toBe(0);
    expect(playbackVolumes({ ...base, deafened: true, watched: true }).stream).toBe(1);
    expect(playbackVolumes({ ...base, deafened: true, watched: true, streamWhileDeafened: false }).stream).toBe(0);
    // Not deafened: watching does not matter (streams play like before).
    expect(playbackVolumes({ ...base, watched: false }).stream).toBe(1);
  });

  it("a local mute silences the voice and the stream audio of that person, whatever the volumes (issue #124)", () => {
    expect(playbackVolumes({ ...base, localMuted: true })).toEqual({ microphone: 0, stream: 0 });
    expect(playbackVolumes({ ...base, localMuted: true, voice: 200, stream: 200, output: 200, watched: true })).toEqual({ microphone: 0, stream: 0 });
    expect(playbackVolumes({ ...base, localMuted: false })).toEqual({ microphone: 1, stream: 1 });
    const s: VoiceSettings = { ...DEFAULT_SETTINGS, userVolumes: { "a@n": 150 } };
    expect(participantVolumes(s, "a@n", { deafened: false, watched: true, localMuted: true })).toEqual({ microphone: 0, stream: 0 });
    expect(participantVolumes(s, "a@n", { deafened: false, watched: true })).toEqual({ microphone: 1.5, stream: 1 });
  });

  it("reads the per-person voice and stream volumes and the output volume from the settings", () => {
    const s: VoiceSettings = { ...DEFAULT_SETTINGS, outputVolume: 50, userVolumes: { "a@n": 200 }, streamVolumes: { "a@n": 40 } };
    expect(participantVolumes(s, "a@n", { deafened: false, watched: false })).toEqual({ microphone: 1, stream: 0.2 });
    // Absent entries are 100 %.
    expect(participantVolumes(s, "b@n", { deafened: false, watched: false })).toEqual({ microphone: 0.5, stream: 0.5 });
    expect(participantVolumes(s, "a@n", { deafened: true, watched: true })).toEqual({ microphone: 0, stream: 0.2 });
    expect(participantVolumes({ ...s, streamWhileDeafened: false }, "a@n", { deafened: true, watched: true })).toEqual({ microphone: 0, stream: 0 });
  });
});
