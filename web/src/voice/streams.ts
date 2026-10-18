// SPDX-License-Identifier: Apache-2.0
/**
 * Screen shares are opt-in (docs/CLIENT.md "Streams are joined"): nobody receives a screen share until they join
 * it. The browser engine connects with LiveKit's auto-subscription off and subscribes every publication at once
 * except the stream sources (screen share video and its audio); those are subscribed only while this viewer has
 * joined that participant's stream, and unsubscribed again on leave, any number of times without reconnecting.
 * Microphones and cameras behave as before (a camera still replaces the tile's avatar by itself).
 *
 * No LiveKit import: the session hands its publications in (`session.ts`), the tests hand in mocks. LiveKit's
 * `Track.Source` values are plain strings.
 */
import { isWhisperTrack } from "./whisperAccess";
import type { VoiceStatus, VoiceTarget } from "./store";

/** `Track.Source` of the screen share video and of the screen share's audio. */
const STREAM_SOURCES: ReadonlySet<string> = new Set(["screen_share", "screen_share_audio"]);

/** Whether a track of this source belongs to a stream (subscribed only after joining it). */
export const isStreamSource = (source: string): boolean => STREAM_SOURCES.has(source);

/** What the subscription logic needs of a LiveKit `RemoteTrackPublication`. */
export interface SubscribablePublication {
  readonly source: string;
  readonly trackName?: string;
  /** The client wants the track (LiveKit: subscribed, or about to be). */
  readonly isDesired: boolean;
  setSubscribed(subscribed: boolean): void;
}

/** What it needs of a LiveKit `RemoteParticipant`. */
export interface StreamParticipant {
  readonly identity: string;
  readonly trackPublications: ReadonlyMap<string, SubscribablePublication>;
}

/** The streams this viewer joined (per participant identity) and the subscriptions that follow from them. */
export class StreamSubscriptions {
  private readonly joinedSet = new Set<string>();

  constructor(
    /** The remote participants of the call right now. */
    private readonly participants: () => Iterable<StreamParticipant>,
    /** Called with the joined identities after every change (the session writes them to the store). */
    private readonly onChange: (joined: ReadonlySet<string>) => void = () => undefined,
  ) {}

  isJoined(identity: string): boolean {
    return this.joinedSet.has(identity);
  }

  joined(): string[] {
    return [...this.joinedSet];
  }

  /** Everything but streams at once, a stream only while joined. */
  private wants(identity: string, source: string): boolean {
    return !isStreamSource(source) || this.joinedSet.has(identity);
  }

  /** Brings one publication to the wanted state (a track published now, or one already there). */
  apply(identity: string, pub: SubscribablePublication): void {
    if (isWhisperTrack(pub.trackName)) return;
    const want = this.wants(identity, pub.source);
    if (pub.isDesired !== want) pub.setSubscribed(want);
  }

  /** Every publication of the call (after connecting: the tracks of those who were there before). */
  applyAll(): void {
    for (const p of this.participants()) for (const pub of p.trackPublications.values()) this.apply(p.identity, pub);
  }

  private find(identity: string): StreamParticipant | undefined {
    for (const p of this.participants()) if (p.identity === identity) return p;
    return undefined;
  }

  private applyTo(identity: string): void {
    const p = this.find(identity);
    if (p) for (const pub of p.trackPublications.values()) this.apply(identity, pub);
  }

  /** Joins the stream of `identity`: its video and audio are subscribed. False when nobody of that identity is here. */
  join(identity: string): boolean {
    if (!this.find(identity)) return false;
    if (this.joinedSet.has(identity)) return true;
    this.joinedSet.add(identity);
    this.applyTo(identity);
    this.onChange(this.joinedSet);
    return true;
  }

  /** Leaves the stream of `identity`: video and audio are unsubscribed, the tile is a placeholder again. */
  leave(identity: string): void {
    if (!this.joinedSet.delete(identity)) return;
    this.applyTo(identity);
    this.onChange(this.joinedSet);
  }

  /** Forgets joined streams that ended (sharing stopped, the participant left): a new share is joined anew. */
  prune(streaming: (identity: string) => boolean): void {
    let changed = false;
    for (const identity of this.joinedSet) {
      if (streaming(identity)) continue;
      this.joinedSet.delete(identity);
      changed = true;
    }
    if (changed) this.onChange(this.joinedSet);
  }

  clear(): void {
    if (!this.joinedSet.size) return;
    this.joinedSet.clear();
    this.onChange(this.joinedSet);
  }
}

/**
 * Screen publishers (VOICE.md §4b): a device may publish its screen as a second participant `<identity>#screen` (the
 * Android app, whose webview cannot share the screen). The node lists it with `screen_of` = the device's identity;
 * LiveKit names it by the suffix alone, also before the node reported it. It is that device's stream, never a
 * participant of its own.
 */
export const SCREEN_SUFFIX = "#screen";

/** The device a screen publisher's identity belongs to, or null for a device's own identity. */
export function screenOwner(identity: string): string | null {
  return identity.endsWith(SCREEN_SUFFIX) && identity.length > SCREEN_SUFFIX.length ? identity.slice(0, -SCREEN_SUFFIX.length) : null;
}

/** A stream of another device's screen publisher, shown under that device's user. */
export interface PublisherStream {
  /** The screen publisher's identity (its LiveKit participant). */
  identity: string;
  /** The device it belongs to. */
  owner: string;
}

/**
 * The screen publishers of the call to show as streams: the node's (`screen_of`) and those LiveKit already
 * connected (by the suffix), each once, never this device's own (its sharer sees the "You are streaming" bar, and
 * the publisher sends nothing back to its own device).
 */
export function publisherStreams(nodeScreens: ReadonlyArray<{ identity: string; screen_of?: string | null }>, livekitIdentities: Iterable<string>, self: string | null): PublisherStream[] {
  const out = new Map<string, PublisherStream>();
  for (const p of nodeScreens) {
    const owner = p.screen_of ?? screenOwner(p.identity);
    if (owner && owner !== self) out.set(p.identity, { identity: p.identity, owner });
  }
  for (const identity of livekitIdentities) {
    const owner = screenOwner(identity);
    if (owner && owner !== self && !out.has(identity)) out.set(identity, { identity, owner });
  }
  return [...out.values()];
}

/**
 * The identity whose stream a viewer joins for `identity` (a member row names the device): the device's own share
 * if it publishes one, else its screen publisher's when that shares.
 */
export function streamIdentity(identity: string, sharing: (identity: string) => boolean): string {
  if (sharing(identity) || screenOwner(identity)) return identity;
  const publisher = identity + SCREEN_SUFFIX;
  return sharing(publisher) ? publisher : identity;
}

/** What a double-click (or Enter) on a member of the voice member list does. */
export type RowStreamAction = "join" | "preview" | "hint" | null;

/**
 * A streaming member's row joins their stream, but only while this device is in that same voice channel
 * (otherwise a hint); the own row reopens the own preview; members who do not stream: nothing.
 */
export function rowStreamAction(member: { identity: string; streaming: boolean }, viewer: { status: VoiceStatus; target: VoiceTarget | null; identity: string | null }, channel: { domain: string; channelId: string }): RowStreamAction {
  if (!member.streaming) return null;
  const t = viewer.target;
  const here = (viewer.status === "connected" || viewer.status === "reconnecting") && !!t && !t.call && t.domain === channel.domain && t.channelId === channel.channelId;
  if (!here) return "hint";
  return member.identity === viewer.identity ? "preview" : "join";
}
