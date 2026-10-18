// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { WhisperSender, whisperPermissions, type WhisperPort } from "./whisper";
function harness(fail?: string) {
  const log: string[] = [];
  let output = false;
  let mainMuted = false;
  let permitted = false;
  const step = (name: string) => { log.push(name); if (name === fail) throw new Error(name); };
  const port: WhisperPort = {
    active: () => true, canStart: () => true, resolve: (ids) => ids.filter((id) => id !== "gone@n/d"),
    prepare: async () => step("key"), publish: async () => step("publish"),
    permissions: (ids) => { step(ids.length ? "restrict" : "all"); permitted = !!ids.length; },
    mainMuted: async (muted) => { step(`main:${muted}`); mainMuted = muted; },
    whisperMuted: async (muted) => step(`whisper:${muted}`),
    output: (on) => { if (on) { expect(permitted).toBe(true); expect(mainMuted).toBe(true); } output = on; log.push(`output:${on}`); },
    transition: (on) => step(`transition:${on}`),
    hold: (on) => step(`hold:${on}`), send: async (data, ids) => { expect(ids.length).toBeGreaterThan(0); step(JSON.parse(new TextDecoder().decode(data)).type); },
    changed: (ids) => step(`state:${ids.join(",")}`), cue: (on) => step(`cue:${on}`), failed: () => log.push("failed"), recover: () => log.push("recover"),
  };
  return { sender: new WhisperSender(port), port, log, output: () => output, mainMuted: () => mainMuted };
}
describe("whisper sender privacy and restoration", () => {
  it("restricts before publish and opens audio only after main mute and targeted start", async () => {
    const h = harness(); await h.sender.set(["a@n/d", "a@n/d", "gone@n/d"]);
    expect(h.sender.recipients).toEqual(["a@n/d"]); expect(h.output()).toBe(true);
    expect(h.log.indexOf("restrict")).toBeLessThan(h.log.indexOf("publish"));
    expect(h.log.indexOf("main:true")).toBeLessThan(h.log.indexOf("whisper.start"));
    expect(h.log.indexOf("whisper.start")).toBeLessThan(h.log.indexOf("output:true"));
    await h.sender.set([]);
    expect(h.output()).toBe(false); expect(h.mainMuted()).toBe(false); expect(h.sender.recipients).toEqual([]);
    expect(h.log.lastIndexOf("output:false")).toBeLessThan(h.log.indexOf("all"));
  });
  for (const step of ["key", "restrict", "publish", "main:true", "whisper.start", "whisper:false"]) it(`restores normal talk after ${step} fails without opening whisper output`, async () => {
    const h = harness(step); await h.sender.set(["a@n/d"]);
    expect(h.output()).toBe(false); expect(h.mainMuted()).toBe(false); expect(h.sender.recipients).toEqual([]); expect(h.log).toContain("failed");
  });
  it("a release during slow publication never opens audio after the key went up", async () => {
    const h = harness(); let finish!: () => void; let entered!: () => void;
    const publishing = new Promise<void>((r) => { entered = r; });
    h.port.publish = () => { entered(); return new Promise<void>((r) => { finish = r; }); };
    const start = h.sender.set(["a@n/d"]); await publishing;
    const end = h.sender.set([]); expect(h.output()).toBe(false);
    finish(); await Promise.all([start, end]); expect(h.log).not.toContain("output:true"); expect(h.mainMuted()).toBe(false);
  });
  it("resends permissions on membership/publication change and ends on resync failure", async () => {
    const h = harness(); await h.sender.set(["a@n/d"]);
    h.sender.resync(); expect(h.log.filter((x) => x === "restrict")).toHaveLength(3);
    h.port.permissions = (ids) => { if (ids.length) throw new Error("resync"); };
    h.sender.resync(); expect(h.output()).toBe(false);
    await h.sender.set([]); expect(h.sender.recipients).toEqual([]); expect(h.mainMuted()).toBe(false);
  });
  it("keeps every main track accessible and handles late participants and publications", () => {
    const tracks = [{ trackSid: "mic", trackName: "microphone" }, { trackSid: "cam", trackName: "camera" }, { trackSid: "wh", trackName: "whisper" }, { trackSid: "screen", trackName: "screen" }];
    const p = whisperPermissions(["a", "b", "late"], tracks, ["a"]);
    expect(p[0]!.allowedTrackSids).toEqual(["mic", "cam", "screen", "wh"]);
    for (const entry of p.slice(1)) expect(entry.allowedTrackSids).toEqual(["mic", "cam", "screen"]);
  });
  it("reserves end packets and refuses a sixth rapid hold", async () => {
    const h = harness(); for (let i = 0; i < 6; i++) { await h.sender.set(["a@n/d"]); await h.sender.set([]); }
    expect(h.log.filter((s) => s === "whisper.start")).toHaveLength(5); expect(h.log.filter((s) => s === "whisper.end")).toHaveLength(5);
  });
});

it("disconnects to ordinary voice when cleanup cannot confirm track stop or permissions", async () => {
  for (const failure of ["whisper:true", "all"]) {
    const h = harness(failure); await h.sender.set(["a@n/d"]); await h.sender.set([]);
    expect(h.output()).toBe(false); expect(h.log).toContain("recover");
    expect(h.log).not.toContain("main:false");
  }
});

it("keeps the normal destination closed throughout a recipient change", async () => {
  const h = harness(); await h.sender.set(["a@n/d"]);
  h.log.length = 0; await h.sender.set(["b@n/d"]);
  expect(h.log[0]).toBe("transition:true");
  expect(h.log.indexOf("main:false")).toBeLessThan(h.log.indexOf("main:true"));
  expect(h.log.lastIndexOf("transition:false")).toBeGreaterThan(h.log.indexOf("output:true"));
  expect(h.sender.recipients).toEqual(["b@n/d"]);
});
