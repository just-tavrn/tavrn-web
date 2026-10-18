// SPDX-License-Identifier: Apache-2.0
import { encodeWhisperSignal, WhisperLimiter } from "./whisperSignal";

/** The media adapter owns E2EE preparation, publications and the call's user mute state. */
export interface WhisperPort {
  active(): boolean;
  canStart(): boolean;
  resolve(recipients: string[]): string[];
  prepare(): Promise<void>;
  publish(): Promise<void>;
  permissions(recipients: string[]): void;
  mainMuted(muted: boolean): Promise<void>;
  whisperMuted(muted: boolean): Promise<void>;
  output(on: boolean): void;
  hold(on: boolean): void;
  transition(on: boolean): void;
  send(data: Uint8Array, recipients: string[]): Promise<void>;
  changed(recipients: string[]): void;
  cue(start: boolean): void;
  failed(error: unknown): void;
  recover(): void;
}

/** A single serialized sender. A release silences audio synchronously, even during a slow publish. */
export class WhisperSender {
  recipients: string[] = [];
  private revision = 0;
  private announced = false;
  private queue = Promise.resolve();
  private readonly limiter = new WhisperLimiter();
  constructor(private readonly port: WhisperPort) {}

  set(recipients: string[]): Promise<void> {
    const revision = ++this.revision;
    // Close both routes at intent time, even while a previous asynchronous transition is pending.
    if (this.port.active()) {
      this.port.transition(recipients.length > 0);
      this.port.output(false);
    }
    this.queue = this.queue.then(async () => {
      if (!this.port.active()) return;
      try {
        await this.end();
        if (revision !== this.revision || !this.port.canStart()) return;
        const ids = this.port.resolve([...new Set(recipients)]);
        if (!ids.length) return;
        try {
          const data = encodeWhisperSignal("whisper.start", ids);
          // Reserve the end signal too: rapid holds cannot exceed ten packets per ten seconds.
          if (!this.limiter.canAllow("self", 2)) return;
          await bounded(this.port.prepare());
          if (revision !== this.revision || !this.port.canStart()) return;
          this.recipients = ids;
          await bounded(this.port.mainMuted(true));
          this.port.permissions(ids);
          await bounded(this.port.publish());
          this.port.permissions(ids);
          if (revision !== this.revision || !this.port.canStart()) { await this.end(); return; }
          this.limiter.allow("self");
          await bounded(this.port.send(data, ids));
          if (revision !== this.revision || !this.port.canStart()) { await this.end(); return; }
          await bounded(this.port.whisperMuted(false));
          if (revision !== this.revision || !this.port.canStart()) { await this.end(); return; }
          this.port.hold(true);
          this.port.output(true);
          this.port.changed(ids);
          this.announced = true;
          this.port.cue(true);
        } catch (e) {
          if (e instanceof WhisperTimeoutError) {
            // Promise.race cannot cancel a late SDK operation. Destroy its connection before it can settle.
            this.dispose();
            this.port.recover();
          } else await this.end();
          this.port.failed(e);
        }
      } finally { if (revision === this.revision) this.port.transition(false); }
    }).catch((e) => { this.port.output(false); this.port.failed(e); });
    return this.queue;
  }

  resync(): void {
    if (!this.recipients.length) return;
    try { this.port.permissions(this.recipients); }
    catch (e) { this.port.output(false); this.port.failed(e); void this.set([]); }
  }

  /** Call teardown never waits on a stalled network operation to silence media. */
  dispose(): void {
    ++this.revision;
    this.port.output(false);
    this.recipients = [];
    this.port.changed([]);
  }

  private async end(): Promise<void> {
    this.port.output(false);
    const ids = this.recipients;
    if (!ids.length) return;
    this.recipients = [];
    this.port.changed([]);
    const attempt = async (fn: () => unknown) => { try { await bounded(Promise.resolve(fn())); return true; } catch (e) { this.port.failed(e); return false; } };
    if (!await attempt(() => this.port.whisperMuted(true))) { this.port.recover(); return; }
    if (this.limiter.allow("self")) await attempt(() => this.port.send(encodeWhisperSignal("whisper.end", ids), ids));
    if (!await attempt(() => this.port.permissions([]))) { this.port.recover(); return; }
    this.port.hold(false);
    if (!await attempt(() => this.port.mainMuted(false))) this.port.recover();
    if (this.announced) this.port.cue(false);
    this.announced = false;
  }
}

/** Every ordinary track stays accessible; only addressed identities may subscribe to the second track. */
export function whisperPermissions(participants: Iterable<string>, tracks: Iterable<{ trackSid: string; trackName: string }>, recipients: string[]) {
  const publications = [...tracks];
  const main = publications.filter((p) => p.trackName !== "whisper").map((p) => p.trackSid);
  const whisper = publications.filter((p) => p.trackName === "whisper").map((p) => p.trackSid);
  return [...participants].map((participantIdentity) => ({ participantIdentity, allowAll: false,
    allowedTrackSids: recipients.includes(participantIdentity) ? [...main, ...whisper] : [...main],
  }));
}


class WhisperTimeoutError extends Error {}

/** Network failures cannot leave a hold or normal microphone restoration waiting forever. */
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WhisperTimeoutError("Whisper operation timed out")), 10_000);
  })]).finally(() => clearTimeout(timer));
}
