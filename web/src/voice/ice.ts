// SPDX-License-Identifier: Apache-2.0
/**
 * ICE candidates of the node's media server (VOICE.md §10.2, §10.4).
 *
 * LiveKit announces at most one address per family (`node_ip`). Further addresses the operator configured
 * (`TAVRN_RTC_ADVERTISE_IPS`, e.g. the LAN address for clients at home when the router has no NAT
 * loopback) arrive with the join answer as `ice_aliases`: every host candidate of the server is added once
 * more with each alias address of the same family (same port, slightly lower priority). The connection test
 * also uses this layer to allow only one kind of candidate per attempt (UDP to one address, TCP, TURN).
 *
 * Works by wrapping `window.RTCPeerConnection` once: a peer connection takes the policy that is current
 * when it is created (LiveKit creates its connections while joining), so a running call keeps its own.
 */

export interface Candidate {
  foundation: string;
  component: string;
  protocol: "udp" | "tcp";
  priority: number;
  address: string;
  port: number;
  type: "host" | "srflx" | "prflx" | "relay";
  /** `active`, `passive` or `so` for TCP candidates. */
  tcpType?: string;
}

export interface IcePolicy {
  /** Extra addresses for every host candidate of the same family. */
  aliases: string[];
  /** Remote candidates to keep (after adding aliases); absent = all. */
  filter?: (c: Candidate) => boolean;
  /** ICE server URLs to keep (TURN tests); absent = all. */
  iceServer?: (url: string) => boolean;
}

const NONE: IcePolicy = { aliases: [] };
let policy: IcePolicy = NONE;
let installed = false;
/** Peer connections created under the current policy (the connection test reads their stats). */
let created: RTCPeerConnection[] = [];

const isV6 = (address: string) => address.includes(":");

/** Parses `candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> …`. */
export function parseCandidate(line: string): Candidate | null {
  const text = line.trim().replace(/^a=/, "").replace(/^candidate:/, "");
  const f = text.split(/\s+/);
  if (f.length < 8 || f[6] !== "typ") return null;
  const protocol = f[2]!.toLowerCase();
  const type = f[7]!;
  const port = Number(f[5]);
  const priority = Number(f[3]);
  if ((protocol !== "udp" && protocol !== "tcp") || !["host", "srflx", "prflx", "relay"].includes(type) || !Number.isInteger(port) || !Number.isFinite(priority)) return null;
  const tcpIndex = f.indexOf("tcptype");
  return {
    foundation: f[0]!,
    component: f[1]!,
    protocol,
    priority,
    address: f[4]!,
    port,
    type: type as Candidate["type"],
    ...(tcpIndex > 0 && f[tcpIndex + 1] ? { tcpType: f[tcpIndex + 1] } : {}),
  };
}

/** The candidate line once more with `address` (own foundation, priority one step lower). */
export function withAddress(line: string, address: string, n: number): string {
  const prefix = line.startsWith("a=") ? "a=" : "";
  const body = line.slice(prefix.length);
  const hasKeyword = body.startsWith("candidate:");
  const f = body.replace(/^candidate:/, "").split(/\s+/);
  f[0] = `${f[0]}a${n}`;
  f[3] = String(Math.max(0, Number(f[3]) - 1 - n));
  f[4] = address;
  return `${prefix}${hasKeyword ? "candidate:" : ""}${f.join(" ")}`;
}

/** Applies a policy to one remote candidate line: the line itself and its aliases, filtered. */
export function rewriteCandidate(line: string, p: IcePolicy): string[] {
  const c = parseCandidate(line);
  if (!c) return [line];
  const out: Array<[string, Candidate]> = [[line, c]];
  if (c.type === "host") {
    p.aliases
      .filter((a) => isV6(a) === isV6(c.address) && a !== c.address)
      .forEach((a, i) => out.push([withAddress(line, a, i), { ...c, address: a }]));
  }
  return out.filter(([, cand]) => !p.filter || p.filter(cand)).map(([l]) => l);
}

/** Applies a policy to the `a=candidate` lines of an SDP. */
export function rewriteSdp(sdp: string, p: IcePolicy): string {
  if (!p.aliases.length && !p.filter) return sdp;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  return sdp
    .split(eol)
    .flatMap((l) => (l.startsWith("a=candidate:") ? rewriteCandidate(l, p) : [l]))
    .join(eol);
}

/** Keeps only the ICE server URLs the policy allows (servers without URLs left are dropped). */
export function filterIceServers(servers: RTCIceServer[], keep: (url: string) => boolean): RTCIceServer[] {
  return servers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(keep) }))
    .filter((s) => s.urls.length > 0);
}

/** Sets the policy for peer connections created from now on; returns the previous one. */
export function setIcePolicy(next: IcePolicy | null): IcePolicy {
  install();
  const prev = policy;
  policy = next ?? NONE;
  created = [];
  return prev;
}

/** Peer connections created since the last {@link setIcePolicy}. */
export function createdConnections(): RTCPeerConnection[] {
  return created.slice();
}

function install(): void {
  if (installed || typeof window === "undefined" || typeof window.RTCPeerConnection !== "function") return;
  installed = true;
  const Native = window.RTCPeerConnection;
  class TavrnPeerConnection extends Native {
    private readonly tavrnPolicy: IcePolicy;

    constructor(config?: RTCConfiguration) {
      const p = policy;
      const servers = config?.iceServers && p.iceServer ? filterIceServers(config.iceServers, p.iceServer) : config?.iceServers;
      super(config ? { ...config, ...(servers ? { iceServers: servers } : {}) } : config);
      this.tavrnPolicy = p;
      created.push(this);
    }

    override addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
      const p = this.tavrnPolicy;
      const line = candidate?.candidate;
      if (!line || (!p.aliases.length && !p.filter)) return super.addIceCandidate(candidate ?? undefined);
      const lines = rewriteCandidate(line, p);
      return Promise.all(lines.map((l) => super.addIceCandidate({ ...candidate, candidate: l }))).then(() => undefined);
    }

    override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      const p = this.tavrnPolicy;
      if (!description?.sdp || (!p.aliases.length && !p.filter)) return super.setRemoteDescription(description);
      return super.setRemoteDescription({ type: description.type, sdp: rewriteSdp(description.sdp, p) });
    }
  }
  window.RTCPeerConnection = TavrnPeerConnection;
}

/** What the connection test learns from a connected peer connection's statistics. */
export interface SelectedPair {
  localType: string;
  remoteType: string;
  protocol: string;
  remoteAddress: string;
  remotePort: number;
  rttMs: number | null;
}

/** The selected candidate pair of a connected peer connection. */
export async function selectedPair(pc: RTCPeerConnection): Promise<SelectedPair | null> {
  const stats = await pc.getStats();
  const all = new Map<string, Record<string, unknown>>();
  stats.forEach((s: Record<string, unknown>) => all.set(s.id as string, s));
  let pairId: string | undefined;
  for (const s of all.values()) if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") pairId = s.selectedCandidatePairId;
  const pair = pairId ? all.get(pairId) : [...all.values()].find((s) => s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded")));
  if (!pair) return null;
  const local = all.get(pair.localCandidateId as string);
  const remote = all.get(pair.remoteCandidateId as string);
  if (!local || !remote) return null;
  const rtt = typeof pair.currentRoundTripTime === "number" ? Math.round(pair.currentRoundTripTime * 1000) : null;
  return {
    localType: String(local.candidateType ?? "?"),
    remoteType: String(remote.candidateType ?? "?"),
    protocol: String(remote.protocol ?? local.protocol ?? "?"),
    remoteAddress: String(remote.address ?? remote.ip ?? ""),
    remotePort: Number(remote.port ?? 0),
    rttMs: rtt,
  };
}
