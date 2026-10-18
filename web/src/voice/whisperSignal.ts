// SPDX-License-Identifier: Apache-2.0
/** Call-local, targeted whisper control (VOICE.md §4c). Never broadcast. */
export const WHISPER_TOPIC = "tavrn.whisper";
export interface WhisperSignal { type: "whisper.start" | "whisper.end"; recipients: string[] }
export function parseWhisperSignal(data: Uint8Array): WhisperSignal | null {
  if (data.byteLength > 512) return null;
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    if (!v || (v.type !== "whisper.start" && v.type !== "whisper.end") || !Array.isArray(v.recipients) || !v.recipients.length) return null;
    if (!v.recipients.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 320 && !/[\x00-\x20\x7f]/.test(id) && /^[^\s/@]+@[^\s/]+\/[^\s/#]+$/.test(id))) return null;
    if (new Set(v.recipients).size !== v.recipients.length) return null;
    return { type: v.type, recipients: v.recipients };
  } catch { return null; }
}
export function encodeWhisperSignal(type: WhisperSignal["type"], recipients: string[]): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify({ type, recipients }));
  if (!parseWhisperSignal(data)) throw new Error("Invalid whisper recipients");
  return data;
}
export class WhisperLimiter {
  private readonly times = new Map<string, number[]>();
  canAllow(sender: string, count: number, now = Date.now()): boolean {
    return (this.times.get(sender) ?? []).filter((t) => now - t < 10_000).length + count <= 10;
  }
  allow(sender: string, now = Date.now(), count = 1): boolean {
    const recent = (this.times.get(sender) ?? []).filter((t) => now - t < 10_000);
    this.times.set(sender, recent);
    if (recent.length + count > 10) return false;
    for (let i = 0; i < count; i++) recent.push(now);
    return true;
  }
  clear(): void { this.times.clear(); }
  forget(sender: string): void { this.times.delete(sender); }
}

/** Validate against transport identity and the current connection, never a JSON-claimed sender. */
export function addressedWhisper(data: Uint8Array, self: string, sender: string, participants: ReadonlySet<string>, reliable: boolean): WhisperSignal | null {
  if (!reliable || sender === self || !participants.has(sender)) return null;
  const signal = parseWhisperSignal(data);
  if (!signal || !signal.recipients.includes(self) || signal.recipients.some((id) => id === sender || id.endsWith("#screen") || !participants.has(id))) return null;
  return signal;
}
