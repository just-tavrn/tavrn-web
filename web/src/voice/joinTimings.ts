// SPDX-License-Identifier: Apache-2.0
/**
 * Voice join timings for troubleshooting (docs/CLIENT.md "Voice troubleshooting"). Off unless
 * `localStorage["tavrn.debug.voice"]` is `"1"` (the voice settings' "Log join timings"); then:
 *
 * - every stage of a join and a leave is a `performance.mark("vj:<stage>")` (with its details), and
 * - once the call is connected, one `console.info` prints a table: the stages since the click with their durations,
 *   the opening of the media server's signalling WebSocket (`/rtc`), each peer connection from its creation through
 *   ICE checking to connected, and the selected candidate pair (`getStats`: local and remote candidate type, UDP or
 *   TCP, round-trip time).
 *
 * For the WebSocket and the peer connections the constructors are wrapped while a join runs (only with the flag on)
 * and restored afterwards. Without the flag nothing is marked, wrapped or printed. Light module: no LiveKit import.
 */

export const VOICE_DEBUG_KEY = "tavrn.debug.voice";

/** Whether the join timings are on (`localStorage`, per browser profile). */
export function voiceDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(VOICE_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setVoiceDebug(on: boolean): void {
  try {
    if (on) localStorage.setItem(VOICE_DEBUG_KEY, "1");
    else localStorage.removeItem(VOICE_DEBUG_KEY);
  } catch {
    /* storage unavailable: stays off */
  }
}

/** Marks a stage (`vj:<stage>`) when the timings are on. */
export function vjMark(stage: string, detail?: Record<string, unknown>): void {
  if (!voiceDebugEnabled()) return;
  try {
    performance.mark(`vj:${stage}`, detail ? { detail } : undefined);
  } catch {
    /* never in the way */
  }
}

interface SocketRecord {
  start: number;
  open?: number;
}

interface PcRecord {
  pc: RTCPeerConnection;
  created: number;
  checking?: number;
  connected?: number;
}

interface Probe {
  sockets: SocketRecord[];
  pcs: PcRecord[];
  restore: () => void;
}

let probe: Probe | null = null;

/** Starts a join's timings: the `click` mark and, with the flag on, the WebSocket and peer connection probes. */
export function beginJoinTimings(detail?: Record<string, unknown>): void {
  endProbe();
  if (!voiceDebugEnabled()) return;
  try {
    for (const m of performance.getEntriesByType("mark")) if (m.name.startsWith("vj:")) performance.clearMarks(m.name);
  } catch {
    /* fine */
  }
  vjMark("click", detail);
  const g = globalThis as unknown as { WebSocket?: typeof WebSocket; RTCPeerConnection?: typeof RTCPeerConnection };
  const NativeWs = g.WebSocket;
  const NativePc = g.RTCPeerConnection;
  const p: Probe = { sockets: [], pcs: [], restore: () => undefined };
  if (NativeWs) {
    g.WebSocket = class extends NativeWs {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!new URL(String(url), location.href).pathname.includes("/rtc")) return;
        const rec: SocketRecord = { start: performance.now() };
        p.sockets.push(rec);
        this.addEventListener("open", () => (rec.open = performance.now()), { once: true });
      }
    };
  }
  if (NativePc) {
    g.RTCPeerConnection = class extends NativePc {
      constructor(config?: RTCConfiguration) {
        super(config);
        const rec: PcRecord = { pc: this, created: performance.now() };
        p.pcs.push(rec);
        this.addEventListener("iceconnectionstatechange", () => {
          if (this.iceConnectionState === "checking") rec.checking ??= performance.now();
          if (this.iceConnectionState === "connected" || this.iceConnectionState === "completed") rec.connected ??= performance.now();
        });
      }
    };
  }
  p.restore = () => {
    if (NativeWs) g.WebSocket = NativeWs;
    if (NativePc) g.RTCPeerConnection = NativePc;
  };
  probe = p;
}

function endProbe(): Probe | null {
  const p = probe;
  probe = null;
  p?.restore();
  return p;
}

/** The selected candidate pair of a peer connection (`getStats`). */
async function selectedPair(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats();
    const all = new Map<string, Record<string, unknown>>();
    stats.forEach((s: Record<string, unknown>) => all.set(s.id as string, s));
    for (const s of all.values()) {
      if (s.type !== "transport" || typeof s.selectedCandidatePairId !== "string") continue;
      const pair = all.get(s.selectedCandidatePairId);
      if (!pair) continue;
      const local = all.get(pair.localCandidateId as string);
      const remote = all.get(pair.remoteCandidateId as string);
      const rtt = typeof pair.currentRoundTripTime === "number" ? `${Math.round(pair.currentRoundTripTime * 1000)} ms` : "?";
      return `${String(local?.candidateType)} → ${String(remote?.candidateType)} over ${String(remote?.protocol ?? local?.protocol)}, RTT ${rtt}`;
    }
    return "none";
  } catch {
    return "unavailable";
  }
}

const ms = (n: number) => `${Math.round(n)}`.padStart(6);

/** The stages since the click and the transport details as one text table. */
export async function joinTimingsTable(p: Pick<Probe, "sockets" | "pcs"> | null = probe): Promise<string> {
  const marks = performance.getEntriesByType("mark").filter((m) => m.name.startsWith("vj:"));
  const t0 = marks.find((m) => m.name === "vj:click")?.startTime ?? marks[0]?.startTime ?? 0;
  const lines = ["voice: join timings (ms since the click, + since the stage before)", `${"stage".padEnd(26)}${"at".padStart(6)}${"+".padStart(7)}`];
  let prev = t0;
  for (const m of marks) {
    const detail = (m as PerformanceMark).detail as Record<string, unknown> | null | undefined;
    lines.push(`${m.name.slice(3).padEnd(26)}${ms(m.startTime - t0)} ${ms(m.startTime - prev)}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
    prev = m.startTime;
  }
  for (const s of p?.sockets ?? []) lines.push(`/rtc WebSocket: opened after ${s.open === undefined ? "-" : Math.round(s.open - s.start)} ms (started at ${Math.round(s.start - t0)})`);
  for (const [i, pc] of (p?.pcs ?? []).entries()) {
    const since = (t?: number) => (t === undefined ? "-" : `${Math.round(t - pc.created)} ms`);
    lines.push(`peer connection ${i + 1}: created at ${Math.round(pc.created - t0)}, ICE checking after ${since(pc.checking)}, connected after ${since(pc.connected)}, ${await selectedPair(pc.pc)}`);
  }
  return lines.join("\n");
}

/** At the end of a join (connected or failed): prints the table once (with the flag on) and removes the probes. */
export async function finishJoinTimings(): Promise<void> {
  const p = endProbe();
  if (!p || !voiceDebugEnabled()) return;
  console.info(await joinTimingsTable(p));
}
