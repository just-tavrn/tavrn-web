// SPDX-License-Identifier: Apache-2.0
// The voice join timings (joinTimings.ts): nothing without the flag; with it the marks, the /rtc WebSocket, the peer
// connections and one table on connected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_DEBUG_KEY, beginJoinTimings, finishJoinTimings, setVoiceDebug, vjMark, voiceDebugEnabled } from "./joinTimings";

class FakeSocket extends EventTarget {
  constructor(readonly url: string | URL) {
    super();
  }
}

class FakePc extends EventTarget {
  iceConnectionState = "new";
  async getStats() {
    return new Map<string, Record<string, unknown>>([
      ["t", { id: "t", type: "transport", selectedCandidatePairId: "p" }],
      ["p", { id: "p", type: "candidate-pair", localCandidateId: "l", remoteCandidateId: "r", currentRoundTripTime: 0.042 }],
      ["l", { id: "l", type: "local-candidate", candidateType: "srflx", protocol: "udp" }],
      ["r", { id: "r", type: "remote-candidate", candidateType: "host", protocol: "udp" }],
    ]);
  }
  set(state: string) {
    this.iceConnectionState = state;
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const vjMarks = () => performance.getEntriesByType("mark").filter((m) => m.name.startsWith("vj:")).map((m) => m.name);

beforeEach(() => {
  g.WebSocket = FakeSocket;
  g.RTCPeerConnection = FakePc;
  performance.clearMarks();
});

afterEach(async () => {
  await finishJoinTimings();
  localStorage.removeItem(VOICE_DEBUG_KEY);
  vi.restoreAllMocks();
});

describe("join timings", () => {
  it("off by default: no marks, the constructors stay, nothing is printed", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(voiceDebugEnabled()).toBe(false);
    beginJoinTimings({ channel: "c1" });
    vjMark("ensure_joined_done");
    expect(vjMarks()).toEqual([]);
    expect(g.WebSocket).toBe(FakeSocket);
    expect(g.RTCPeerConnection).toBe(FakePc);
    await finishJoinTimings();
    expect(info).not.toHaveBeenCalled();
  });

  it("with the flag: marks, the /rtc socket and the peer connections, one table on connected, constructors restored", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    setVoiceDebug(true);
    expect(localStorage.getItem(VOICE_DEBUG_KEY)).toBe("1");
    beginJoinTimings({ channel: "c1" });
    vjMark("ensure_joined_done", { epoch: 3 });
    const Ws = g.WebSocket as new (url: string) => FakeSocket;
    const Pc = g.RTCPeerConnection as new () => FakePc;
    expect(Ws).not.toBe(FakeSocket);
    const rtc = new Ws("wss://node.example/rtc/v1?access_token=x");
    new Ws("wss://node.example/api/v1/ws");
    rtc.dispatchEvent(new Event("open"));
    const pc = new Pc();
    pc.set("checking");
    pc.set("connected");
    vjMark("store_connected");
    await finishJoinTimings();
    expect(vjMarks()).toEqual(["vj:click", "vj:ensure_joined_done", "vj:store_connected"]);
    expect(info).toHaveBeenCalledTimes(1);
    const table = String(info.mock.calls[0]![0]);
    expect(table).toContain("ensure_joined_done");
    expect(table).toContain('{"epoch":3}');
    expect(table.match(/\/rtc WebSocket/g)).toHaveLength(1);
    expect(table).toMatch(/peer connection 1: created at \d+, ICE checking after \d+ ms, connected after \d+ ms, srflx → host over udp, RTT 42 ms/);
    expect(g.WebSocket).toBe(FakeSocket);
    expect(g.RTCPeerConnection).toBe(FakePc);
    setVoiceDebug(false);
    expect(voiceDebugEnabled()).toBe(false);
  });
});
