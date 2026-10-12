// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { StreamSubscriptions, isStreamSource, publisherStreams, rowStreamAction, screenOwner, streamIdentity, type StreamParticipant, type SubscribablePublication } from "./streams";

/** A LiveKit remote publication as the browser engine connects (`autoSubscribe: false`: nothing desired yet). */
function publication(source: string, desired = false) {
  const pub = {
    source,
    isDesired: desired,
    setSubscribed: vi.fn((on: boolean) => {
      pub.isDesired = on;
    }),
  };
  return pub satisfies SubscribablePublication;
}

function participant(identity: string, ...pubs: ReturnType<typeof publication>[]): StreamParticipant & { trackPublications: Map<string, ReturnType<typeof publication>> } {
  return { identity, trackPublications: new Map(pubs.map((p, i) => [`TR_${identity}_${i}`, p])) };
}

describe("screen shares are opt-in (streams.ts)", () => {
  it("knows the stream sources: screen share video and audio, nothing else", () => {
    expect(isStreamSource("screen_share")).toBe(true);
    expect(isStreamSource("screen_share_audio")).toBe(true);
    for (const s of ["microphone", "camera", "unknown"]) expect(isStreamSource(s)).toBe(false);
  });

  it("subscribes microphones and cameras at once, a screen share that arrives stays unsubscribed", () => {
    const bob = participant("bob/1", publication("microphone"), publication("camera"));
    const subs = new StreamSubscriptions(() => [bob]);
    subs.applyAll();
    for (const pub of bob.trackPublications.values()) expect(pub.setSubscribed).toHaveBeenCalledWith(true);
    const screen = publication("screen_share");
    const audio = publication("screen_share_audio");
    subs.apply("bob/1", screen);
    subs.apply("bob/1", audio);
    expect(screen.setSubscribed).not.toHaveBeenCalled();
    expect(audio.setSubscribed).not.toHaveBeenCalled();
    expect(screen.isDesired).toBe(false);
  });

  it("refuses a screen share a server subscribed by itself (auto-subscription), keeps the camera", () => {
    const camera = publication("camera", true);
    const screen = publication("screen_share", true);
    const subs = new StreamSubscriptions(() => [participant("bob/1", camera, screen)]);
    subs.applyAll();
    expect(camera.setSubscribed).not.toHaveBeenCalled();
    expect(screen.setSubscribed).toHaveBeenCalledWith(false);
  });

  it("join subscribes the stream's video and audio, leave unsubscribes them, any number of times", () => {
    const mic = publication("microphone", true);
    const screen = publication("screen_share");
    const audio = publication("screen_share_audio");
    const bob = participant("bob/1", mic, screen, audio);
    const changes: string[][] = [];
    const subs = new StreamSubscriptions(() => [bob], (joined) => changes.push([...joined]));
    for (let round = 0; round < 3; round++) {
      expect(subs.join("bob/1")).toBe(true);
      expect(screen.isDesired).toBe(true);
      expect(audio.isDesired).toBe(true);
      expect(subs.isJoined("bob/1")).toBe(true);
      subs.leave("bob/1");
      expect(screen.isDesired).toBe(false);
      expect(audio.isDesired).toBe(false);
      expect(subs.isJoined("bob/1")).toBe(false);
    }
    // The microphone is never touched.
    expect(mic.setSubscribed).not.toHaveBeenCalled();
    expect(changes).toEqual([["bob/1"], [], ["bob/1"], [], ["bob/1"], []]);
  });

  it("a stream track published after joining (the audio comes later) is subscribed at once", () => {
    const bob = participant("bob/1", publication("screen_share"));
    const subs = new StreamSubscriptions(() => [bob]);
    subs.join("bob/1");
    const audio = publication("screen_share_audio");
    subs.apply("bob/1", audio);
    expect(audio.setSubscribed).toHaveBeenCalledWith(true);
  });

  it("joining one stream does not join the others", () => {
    const bob = participant("bob/1", publication("screen_share"), publication("screen_share_audio"));
    const carol = participant("carol/1", publication("screen_share"), publication("screen_share_audio"));
    const subs = new StreamSubscriptions(() => [bob, carol]);
    subs.join("carol/1");
    for (const pub of bob.trackPublications.values()) expect(pub.isDesired).toBe(false);
    for (const pub of carol.trackPublications.values()) expect(pub.isDesired).toBe(true);
    expect(subs.joined()).toEqual(["carol/1"]);
  });

  it("joining an unknown participant does nothing; joining twice is one join", () => {
    const changes: string[][] = [];
    const subs = new StreamSubscriptions(() => [], (joined) => changes.push([...joined]));
    expect(subs.join("ghost/1")).toBe(false);
    const screen = publication("screen_share");
    const subs2 = new StreamSubscriptions(() => [participant("bob/1", screen)], (joined) => changes.push([...joined]));
    subs2.join("bob/1");
    subs2.join("bob/1");
    expect(screen.setSubscribed).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([["bob/1"]]);
  });

  it("a stream that ended is forgotten: the next share of that person is joined anew", () => {
    const bob = participant("bob/1", publication("screen_share"));
    const subs = new StreamSubscriptions(() => [bob]);
    subs.join("bob/1");
    subs.prune((identity) => identity !== "bob/1");
    expect(subs.isJoined("bob/1")).toBe(false);
    const next = publication("screen_share");
    subs.apply("bob/1", next);
    expect(next.setSubscribed).not.toHaveBeenCalled();
  });

  it("clear forgets every joined stream", () => {
    const subs = new StreamSubscriptions(() => [participant("bob/1", publication("screen_share")), participant("carol/1", publication("screen_share"))]);
    subs.join("bob/1");
    subs.join("carol/1");
    subs.clear();
    expect(subs.joined()).toEqual([]);
  });
});

describe("joining a stream from the voice member list (double-click, Enter)", () => {
  const here = { domain: "a.test", channelId: "vc" };
  const viewer = { status: "connected" as const, target: { domain: "a.test", roomId: "r", channelId: "vc" }, identity: "alice/1" };

  it("joins a streaming member's stream while the viewer is in the same voice channel", () => {
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, viewer, here)).toBe("join");
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, { ...viewer, status: "reconnecting" }, here)).toBe("join");
  });

  it("does nothing for members who do not stream", () => {
    expect(rowStreamAction({ identity: "bob/1", streaming: false }, viewer, here)).toBeNull();
  });

  it("the own row reopens the own preview", () => {
    expect(rowStreamAction({ identity: "alice/1", streaming: true }, viewer, here)).toBe("preview");
  });

  it("outside the voice channel (or in a call, or another node's channel) only a hint", () => {
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, { ...viewer, status: "idle", target: null }, here)).toBe("hint");
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, { ...viewer, status: "joining" }, here)).toBe("hint");
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, { ...viewer, target: { ...viewer.target, channelId: "other" } }, here)).toBe("hint");
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, { ...viewer, target: { ...viewer.target, domain: "b.test" } }, here)).toBe("hint");
    expect(rowStreamAction({ identity: "bob/1", streaming: true }, { ...viewer, target: { ...viewer.target, call: true } }, here)).toBe("hint");
  });
});

describe("screen publishers are their device's stream (VOICE.md §4b)", () => {
  const alice = "alice@n.example/01J9AAAAAAAAAAAAAAAAAAAAAA";
  const bob = "bob@n.example/01J9BBBBBBBBBBBBBBBBBBBBBB";

  it("names the owning device by the suffix", () => {
    expect(screenOwner(`${alice}#screen`)).toBe(alice);
    expect(screenOwner(alice)).toBeNull();
    expect(screenOwner("#screen")).toBeNull();
    expect(screenOwner(`${alice}#cam`)).toBeNull();
  });

  it("maps the node's screen_of and LiveKit's identities to one stream per publisher, never the own device's", () => {
    const node = [{ identity: `${bob}#screen`, screen_of: bob }];
    // LiveKit connected alice's publisher before the node reported it; bob's appears in both.
    expect(publisherStreams(node, [`${bob}#screen`, `${alice}#screen`, alice, bob], null)).toEqual([
      { identity: `${bob}#screen`, owner: bob },
      { identity: `${alice}#screen`, owner: alice },
    ]);
    // The sharer's own publisher is no stream tile on its own device.
    expect(publisherStreams(node, [`${alice}#screen`], alice)).toEqual([{ identity: `${bob}#screen`, owner: bob }]);
    expect(publisherStreams([{ identity: `${alice}#screen`, screen_of: alice }], [], alice)).toEqual([]);
    expect(publisherStreams([], [alice, bob], null)).toEqual([]);
  });

  it("joins a member's stream on the device itself or on its screen publisher", () => {
    const sharing = new Set([`${bob}#screen`, alice]);
    const has = (id: string) => sharing.has(id);
    expect(streamIdentity(bob, has)).toBe(`${bob}#screen`);
    // The browser's own share comes first.
    expect(streamIdentity(alice, has)).toBe(alice);
    expect(streamIdentity(`${bob}#screen`, has)).toBe(`${bob}#screen`);
    expect(streamIdentity("carol@n.example/01J9CCCCCCCCCCCCCCCCCCCCCC", has)).toBe("carol@n.example/01J9CCCCCCCCCCCCCCCCCCCCCC");
  });
});
