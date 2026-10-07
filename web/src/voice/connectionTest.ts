// SPDX-License-Identifier: Apache-2.0
/**
 * The connection test of the voice settings (VOICE.md §10.4): connects to a throwaway LiveKit room of the
 * home node several times, each time allowing only one kind of path (UDP to one announced address, ICE over
 * TCP, TURN over UDP, TURN over TLS), and reports which worked, with the round trip and a hint for what an
 * operator has to check when a path fails. Nothing is published; the room is empty and hidden.
 */
import type { ConnectionTest, TavrnApi } from "@tavrn/sdk";
import { createdConnections, selectedPair, setIcePolicy, type Candidate, type IcePolicy, type SelectedPair } from "./ice";

export type ProbeKind = "any" | "udp" | "tcp" | "turn_udp" | "turn_tls";

export interface Probe {
  kind: ProbeKind;
  /** The server address tried (UDP/TCP probes). */
  address?: string;
}

export type HintCode =
  | "signaling"
  | "udp_public"
  | "udp_private"
  | "udp_v6"
  | "tcp"
  | "turn_udp"
  | "turn_tls"
  | "no_media";

export interface ProbeResult {
  probe: Probe;
  ok: boolean;
  pair: SelectedPair | null;
  /** Why it failed, for the hint text. */
  hint: HintCode | null;
}

export interface TestReport {
  /** The signaling WebSocket (`/rtc` through the reverse proxy) worked. */
  signaling: boolean;
  rtc: ConnectionTest["rtc"] | null;
  results: ProbeResult[];
  /** Addresses (and protocols) the node announced to this device. */
  candidates: Candidate[];
}

const PROBE_TIMEOUT_MS = 7_000;

/** RFC 1918 / ULA / loopback: only reachable inside the same network. */
export function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) return /^(fc|fd|fe80|::1$)/i.test(address);
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127);
}

/** The follow-up probes after the first unrestricted one: every announced address per protocol, then TURN. */
export function planProbes(candidates: Candidate[], rtc: ConnectionTest["rtc"]): Probe[] {
  const hosts = candidates.filter((c) => c.type === "host");
  const unique = (protocol: "udp" | "tcp") => [...new Set(hosts.filter((c) => c.protocol === protocol).map((c) => c.address))];
  // Loopback candidates exist only for the TURN relay inside the container.
  const usable = (a: string) => !a.startsWith("127.") && a !== "::1";
  const probes: Probe[] = [...unique("udp").filter(usable).map((address) => ({ kind: "udp" as const, address })), ...unique("tcp").filter(usable).map((address) => ({ kind: "tcp" as const, address }))];
  if (rtc.turn_udp) probes.push({ kind: "turn_udp" });
  if (rtc.turn_tls) probes.push({ kind: "turn_tls" });
  return probes;
}

/** The candidate restriction of a probe. */
export function policyFor(probe: Probe, aliases: string[], seen?: Candidate[]): IcePolicy {
  switch (probe.kind) {
    case "any":
      return { aliases, filter: (c) => (seen?.push(c), true) };
    case "udp":
    case "tcp":
      return { aliases, filter: (c) => c.type === "host" && c.protocol === probe.kind && c.address === probe.address };
    case "turn_udp":
      return { aliases, iceServer: (url) => url.startsWith("turn:") && url.includes("transport=udp") };
    case "turn_tls":
      return { aliases, iceServer: (url) => url.startsWith("turns:") };
  }
}

/** Which hint explains a failed probe. */
export function hintFor(probe: Probe): HintCode {
  switch (probe.kind) {
    case "udp":
      if (probe.address?.includes(":")) return "udp_v6";
      return probe.address && isPrivateAddress(probe.address) ? "udp_private" : "udp_public";
    case "tcp":
      return "tcp";
    case "turn_udp":
      return "turn_udp";
    case "turn_tls":
      return "turn_tls";
    default:
      return "no_media";
  }
}

class SignalingError extends Error {}

async function attempt(api: TavrnApi, probe: Probe, seen?: Candidate[], info?: (rtc: ConnectionTest["rtc"]) => void): Promise<ProbeResult> {
  const test = await api.voice.connectionTest();
  info?.(test.rtc);
  const { Room } = await import("livekit-client");
  const previous = setIcePolicy(policyFor(probe, test.rtc.ice_aliases, seen));
  const room = new Room({ adaptiveStream: false, dynacast: false });
  let signaled = false;
  room.on("signalConnected", () => (signaled = true));
  try {
    const relay = probe.kind === "turn_udp" || probe.kind === "turn_tls";
    const connecting = room.connect(test.url, test.token, {
      autoSubscribe: false,
      maxRetries: 0,
      peerConnectionTimeout: PROBE_TIMEOUT_MS,
      ...(relay ? { rtcConfig: { iceTransportPolicy: "relay" as const } } : {}),
    });
    await Promise.race([connecting, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS + 3_000))]);
    let pair: SelectedPair | null = null;
    for (const pc of createdConnections()) pair ??= await selectedPair(pc).catch(() => null);
    return { probe, ok: true, pair, hint: null };
  } catch {
    if (!signaled) throw new SignalingError("signaling");
    return { probe, ok: false, pair: null, hint: hintFor(probe) };
  } finally {
    await room.disconnect().catch(() => undefined);
    setIcePolicy(previous);
  }
}

/** Runs the whole test; `onProgress` gets the results so far after every attempt. */
export async function runConnectionTest(api: TavrnApi, onProgress?: (r: TestReport) => void): Promise<TestReport> {
  const report: TestReport = { signaling: false, rtc: null, results: [], candidates: [] };
  const seen: Candidate[] = [];
  try {
    const first = await attempt(api, { kind: "any" }, seen, (rtc) => (report.rtc = rtc));
    report.signaling = true;
    report.results.push(first);
  } catch (e) {
    if (e instanceof SignalingError) {
      report.results.push({ probe: { kind: "any" }, ok: false, pair: null, hint: "signaling" });
      onProgress?.({ ...report });
      return report;
    }
    throw e;
  }
  const dedup = new Map(seen.map((c) => [`${c.protocol}|${c.address}|${c.port}|${c.type}`, c]));
  report.candidates = [...dedup.values()];
  if (!report.results[0]!.ok) report.results[0]!.hint = "no_media";
  onProgress?.({ ...report, results: report.results.slice() });
  for (const probe of report.rtc ? planProbes(report.candidates, report.rtc) : []) {
    try {
      report.results.push(await attempt(api, probe));
    } catch {
      report.results.push({ probe, ok: false, pair: null, hint: hintFor(probe) });
    }
    onProgress?.({ ...report, results: report.results.slice() });
  }
  return report;
}
