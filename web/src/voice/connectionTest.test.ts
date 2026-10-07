// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hintFor, isPrivateAddress, planProbes, policyFor } from "./connectionTest";
import type { Candidate } from "./ice";

const c = (address: string, protocol: "udp" | "tcp" = "udp", type: Candidate["type"] = "host"): Candidate => ({ foundation: "1", component: "1", protocol, priority: 1, address, port: 61000, type });
const RTC = { mode: "explicit", addresses: [], ice_aliases: [], udp_ports: "61000-61100", tcp_port: 7881, turn_udp: false, turn_tls: false };

describe("connection test (VOICE.md §10.4)", () => {
  it("tries every announced address per protocol, then TURN", () => {
    const seen = [c("203.0.113.7"), c("203.0.113.7"), c("2001:db8::5"), c("192.168.77.5"), c("203.0.113.7", "tcp"), c("127.0.0.1"), c("203.0.113.7", "udp", "relay")];
    expect(planProbes(seen, RTC)).toEqual([
      { kind: "udp", address: "203.0.113.7" },
      { kind: "udp", address: "2001:db8::5" },
      { kind: "udp", address: "192.168.77.5" },
      { kind: "tcp", address: "203.0.113.7" },
    ]);
    expect(planProbes([], { ...RTC, turn_udp: true, turn_tls: true })).toEqual([{ kind: "turn_udp" }, { kind: "turn_tls" }]);
  });

  it("restricts each attempt to one kind of candidate", () => {
    const udp = policyFor({ kind: "udp", address: "203.0.113.7" }, ["192.168.77.5"]);
    expect(udp.aliases).toEqual(["192.168.77.5"]);
    expect(udp.filter!(c("203.0.113.7"))).toBe(true);
    expect(udp.filter!(c("203.0.113.7", "tcp"))).toBe(false);
    expect(udp.filter!(c("192.168.77.5"))).toBe(false);
    const turn = policyFor({ kind: "turn_tls" }, []);
    expect(turn.filter).toBeUndefined();
    expect(turn.iceServer!("turns:turn.example.org:443?transport=tcp")).toBe(true);
    expect(turn.iceServer!("turn:203.0.113.7:3478?transport=udp")).toBe(false);
    expect(policyFor({ kind: "turn_udp" }, []).iceServer!("turn:203.0.113.7:3478?transport=udp")).toBe(true);
    const seen: Candidate[] = [];
    const any = policyFor({ kind: "any" }, [], seen);
    expect(any.filter!(c("1.2.3.4"))).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("explains failures by the kind of path", () => {
    expect(hintFor({ kind: "udp", address: "203.0.113.7" })).toBe("udp_public");
    expect(hintFor({ kind: "udp", address: "192.168.77.5" })).toBe("udp_private");
    expect(hintFor({ kind: "udp", address: "2001:db8::5" })).toBe("udp_v6");
    expect(hintFor({ kind: "tcp", address: "203.0.113.7" })).toBe("tcp");
    expect(hintFor({ kind: "turn_tls" })).toBe("turn_tls");
    for (const a of ["10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.0.1", "127.0.0.1", "100.64.0.1", "fd00::1", "fe80::1"]) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["203.0.113.7", "172.32.0.1", "2001:db8::1", "8.8.8.8"]) expect(isPrivateAddress(a), a).toBe(false);
  });
});
