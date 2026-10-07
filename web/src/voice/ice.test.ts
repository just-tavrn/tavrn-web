// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { filterIceServers, parseCandidate, rewriteCandidate, rewriteSdp, withAddress } from "./ice";

const HOST_V4 = "candidate:1840965416 1 udp 2130706431 203.0.113.7 61060 typ host generation 0";
const HOST_V6 = "candidate:2 1 udp 2130706175 2001:db8::5 61060 typ host generation 0";
const TCP = "candidate:3 1 tcp 1671430143 203.0.113.7 7881 typ host tcptype passive";
const RELAY = "candidate:4 1 udp 41885439 203.0.113.7 30005 typ relay raddr 0.0.0.0 rport 0";

describe("ICE candidates of the media server (VOICE.md §10.2)", () => {
  it("parses candidate lines and rejects garbage", () => {
    expect(parseCandidate(HOST_V4)).toEqual({ foundation: "1840965416", component: "1", protocol: "udp", priority: 2130706431, address: "203.0.113.7", port: 61060, type: "host" });
    expect(parseCandidate(`a=${TCP}`)).toMatchObject({ protocol: "tcp", port: 7881, tcpType: "passive" });
    expect(parseCandidate(RELAY)?.type).toBe("relay");
    for (const bad of ["", "candidate:1 1 sctp 1 1.2.3.4 1 typ host", "candidate:1 1 udp x 1.2.3.4 1 typ host", "candidate:1 1 udp 1 1.2.3.4 1 type host", "candidate:1 1 udp 1 1.2.3.4 1 typ magic"]) {
      expect(parseCandidate(bad)).toBeNull();
    }
  });

  it("adds every host candidate once more for each alias of the same family", () => {
    const policy = { aliases: ["192.168.77.5", "fd00::5"] };
    const v4 = rewriteCandidate(HOST_V4, policy);
    expect(v4).toEqual([HOST_V4, "candidate:1840965416a0 1 udp 2130706430 192.168.77.5 61060 typ host generation 0"]);
    expect(rewriteCandidate(HOST_V6, policy)).toEqual([HOST_V6, "candidate:2a0 1 udp 2130706174 fd00::5 61060 typ host generation 0"]);
    // TCP host candidates too; relayed ones and lines that do not parse stay as they are.
    expect(rewriteCandidate(TCP, policy)[1]).toContain("192.168.77.5 7881 typ host tcptype passive");
    expect(rewriteCandidate(RELAY, policy)).toEqual([RELAY]);
    expect(rewriteCandidate("garbage", policy)).toEqual(["garbage"]);
    // An alias equal to the announced address adds nothing.
    expect(rewriteCandidate(HOST_V4, { aliases: ["203.0.113.7"] })).toEqual([HOST_V4]);
    expect(withAddress(`a=${HOST_V4}`, "10.0.0.1", 2)).toBe("a=candidate:1840965416a2 1 udp 2130706428 10.0.0.1 61060 typ host generation 0");
  });

  it("filters candidates for the connection test (one kind per attempt)", () => {
    const onlyAlias = { aliases: ["192.168.77.5"], filter: (c: { address: string; protocol: string }) => c.address === "192.168.77.5" && c.protocol === "udp" };
    expect(rewriteCandidate(HOST_V4, onlyAlias)).toEqual(["candidate:1840965416a0 1 udp 2130706430 192.168.77.5 61060 typ host generation 0"]);
    expect(rewriteCandidate(TCP, onlyAlias)).toEqual([]);
    const sdp = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=${HOST_V4}`, `a=${TCP}`, "a=mid:0", ""].join("\r\n");
    const tcpOnly = rewriteSdp(sdp, { aliases: [], filter: (c) => c.protocol === "tcp" });
    expect(tcpOnly).toBe(["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=${TCP}`, "a=mid:0", ""].join("\r\n"));
    expect(rewriteSdp(sdp, { aliases: [] })).toBe(sdp);
  });

  it("keeps only the wanted TURN servers", () => {
    const servers = [{ urls: ["turn:203.0.113.7:3478?transport=udp", "turns:turn.example.org:443?transport=tcp"], username: "u", credential: "c" }, { urls: "stun:stun.example.org:3478" }];
    expect(filterIceServers(servers, (u) => u.startsWith("turns:"))).toEqual([{ urls: ["turns:turn.example.org:443?transport=tcp"], username: "u", credential: "c" }]);
    expect(filterIceServers(servers, () => false)).toEqual([]);
  });
});
