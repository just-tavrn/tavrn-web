// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ChannelGuard, Gate, LevelMeter, dbfs, gateModeFor, routeChannels } from "./gate";

const RATE = 48000;
const BLOCK = 128;

function sine(amplitude: number, blocks: number, freq = 440): Float32Array[] {
  const out: Float32Array[] = [];
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    const block = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++, n++) block[i] = amplitude * Math.sin((2 * Math.PI * freq * n) / RATE);
    out.push(block);
  }
  return out;
}
const silence = (blocks: number) => Array.from({ length: blocks }, () => new Float32Array(BLOCK));
/** Blocks for a duration in ms. */
const ms = (t: number) => Math.ceil((t / 1000) * (RATE / BLOCK));

function run(gate: Gate, blocks: Float32Array[]): { out: Float32Array[]; open: boolean[] } {
  const out: Float32Array[] = [];
  const open: boolean[] = [];
  for (const block of blocks) {
    const o = new Float32Array(BLOCK);
    gate.process(block, o);
    out.push(o);
    open.push(gate.open);
  }
  return { out, open };
}

describe("noise gate / voice activation (synthetic frames)", () => {
  it("measures dBFS of a block", () => {
    expect(dbfs(new Float32Array(BLOCK))).toBe(-Infinity);
    const full = sine(1, 4).flatMap((b) => [...b]);
    expect(Math.abs(dbfs(Float32Array.from(full)) + 3.01)).toBeLessThan(0.2);
    expect(dbfs(sine(0.01, 4)[2]!)).toBeCloseTo(-43, 0);
  });

  it("opens above the threshold and lets the voice through", () => {
    const gate = new Gate(RATE);
    gate.configure({ threshold: -40, holdMs: 200 });
    const { out, open } = run(gate, sine(0.3, ms(100)));
    expect(open.at(-1)).toBe(true);
    // After the attack ramp the output equals the input.
    const last = out.at(-1)!;
    const input = sine(0.3, ms(100)).at(-1)!;
    for (let i = 0; i < BLOCK; i++) expect(last[i]).toBeCloseTo(input[i]!, 5);
  });

  it("stays closed for quiet noise below the threshold and outputs silence", () => {
    const gate = new Gate(RATE);
    gate.configure({ threshold: -40, holdMs: 200 });
    const { out, open } = run(gate, sine(0.001, ms(200)));
    expect(open.every((o) => !o)).toBe(true);
    expect(Math.max(...out.flatMap((b) => [...b].map(Math.abs)))).toBe(0);
  });

  it("holds after speech ends, then closes with a smooth ramp (no clicks)", () => {
    const gate = new Gate(RATE);
    gate.configure({ threshold: -40, holdMs: 200 });
    run(gate, sine(0.3, ms(100)));
    const during = run(gate, silence(ms(150)));
    expect(during.open.every(Boolean)).toBe(true);
    const after = run(gate, [...sine(0.0005, ms(200))]);
    expect(after.open.at(-1)).toBe(false);
    // The gain falls over several blocks instead of jumping to zero.
    const gains = gate.gainHistoryForTest();
    for (let i = 1; i < gains.length; i++) expect(Math.abs(gains[i]! - gains[i - 1]!)).toBeLessThan(0.2);
  });

  it("uses hysteresis: a level just under the open threshold keeps an open gate open", () => {
    const gate = new Gate(RATE);
    gate.configure({ threshold: -40, holdMs: 0 });
    run(gate, sine(0.3, ms(50)));
    // ≈ -43 dBFS: below -40 but above the close threshold (-46).
    const { open } = run(gate, sine(0.01, ms(300)));
    expect(open.every(Boolean)).toBe(true);
  });

  it("is always open without threshold, and push-to-talk forces it open or closed", () => {
    const gate = new Gate(RATE);
    gate.configure({ threshold: null, holdMs: 0 });
    expect(run(gate, sine(0.0001, 4)).open.every(Boolean)).toBe(true);
    gate.configure({ threshold: -40, holdMs: 0 });
    gate.mode = "closed";
    expect(run(gate, sine(0.5, ms(50))).open.some(Boolean)).toBe(false);
    gate.mode = "open";
    expect(run(gate, sine(0.0001, ms(50))).open.every(Boolean)).toBe(true);
  });

  it("reports the loudest level of a window about ten times per second", () => {
    const meter = new LevelMeter(RATE, BLOCK);
    expect(meter.every).toBe(Math.round((RATE * 0.1) / BLOCK));
    let reports = 0;
    let last = -Infinity;
    for (const block of [...sine(0.3, ms(500))]) {
      const r = meter.push(dbfs(block));
      if (r !== null) {
        reports++;
        last = r;
      }
    }
    expect(reports).toBeGreaterThanOrEqual(4);
    expect(reports).toBeLessThanOrEqual(6);
    // A 0.3 sine is about -13.5 dBFS RMS; short blocks wobble a little around it.
    expect(Math.abs(last + 13.5)).toBeLessThan(1);
  });
});

describe("Gate with two channels", () => {
  it("applies one gain to both channels, so a stereo image stays balanced", () => {
    const gate = new Gate(RATE);
    gate.configure({ threshold: -30, holdMs: 0 });
    const loud = sine(0.5, 1)[0]!;
    const quiet = sine(0.01, 1)[0]!;
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    for (let i = 0; i < 40; i++) gate.processChannels([loud, quiet], [outL, outR]);
    // The loud channel opened the gate for both.
    expect(gate.open).toBe(true);
    for (let i = 0; i < BLOCK; i++) expect(outR[i]! / (quiet[i]! || 1)).toBeCloseTo(outL[i]! / (loud[i]! || 1), 6);
  });
});

describe("ChannelGuard (a mono microphone is never heard on one side only)", () => {
  const level = (db: number) => db;
  const feed = (guard: ChannelGuard, l: number, r: number, t: number) => {
    let src = guard.source;
    for (let i = 0; i < ms(t); i++) src = guard.push(level(l), level(r), BLOCK);
    return src;
  };

  it("starts with the average of both channels until it knows more", () => {
    const guard = new ChannelGuard(RATE);
    expect(guard.source).toBe("mix");
    expect(feed(guard, -Infinity, -Infinity, 5000)).toBe("mix");
    expect(feed(guard, -30, -90, 100)).toBe("mix");
  });

  it("puts a single microphone on a two-channel interface on both sides", () => {
    const left = new ChannelGuard(RATE);
    expect(feed(left, -30, -90, 300)).toBe("left");
    const right = new ChannelGuard(RATE);
    expect(feed(right, -Infinity, -25, 300)).toBe("right");
  });

  it("becomes stereo when both channels carry signal, and stays so through one-sided passages", () => {
    const guard = new ChannelGuard(RATE);
    expect(feed(guard, -30, -35, 300)).toBe("stereo");
    // A hard-panned passage or a pause on one side is no reason to fold the image.
    expect(feed(guard, -30, -90, 1500)).toBe("stereo");
    expect(feed(guard, -30, -32, 50)).toBe("stereo");
    expect(feed(guard, -30, -90, 1500)).toBe("stereo");
    // A side that stays silent for 2 s: the live channel goes to both sides.
    expect(feed(guard, -30, -90, 2100)).toBe("left");
    // Both sides again: stereo after 250 ms.
    expect(feed(guard, -30, -30, 300)).toBe("stereo");
  });

  it("ignores silence and quiet-but-not-silent channels", () => {
    const guard = new ChannelGuard(RATE);
    expect(feed(guard, -30, -65, 3000)).toBe("mix");
    expect(feed(guard, -80, -90, 3000)).toBe("mix");
  });

  it("routes the source onto both output channels", () => {
    const l = Float32Array.from([1, 0.5]);
    const r = Float32Array.from([0, -0.5]);
    const scratch = new Float32Array(2);
    expect(routeChannels("stereo", l, r, scratch)).toEqual([l, r]);
    expect(routeChannels("left", l, r, scratch)).toEqual([l, l]);
    expect(routeChannels("right", l, r, scratch)).toEqual([r, r]);
    const [a, b] = routeChannels("mix", l, r, scratch);
    expect(a).toBe(b);
    expect([...a]).toEqual([0.5, 0]);
  });
});

describe("gateModeFor", () => {
  it("voice activation lets the gate decide, push-to-talk follows the key", () => {
    expect(gateModeFor("vad", false, false)).toBe("auto");
    expect(gateModeFor("vad", true, false)).toBe("auto");
    expect(gateModeFor("ptt", false, false)).toBe("closed");
    expect(gateModeFor("ptt", true, false)).toBe("open");
  });

  it("the microphone test of the settings ignores push-to-talk: the gate stays open without the key", () => {
    expect(gateModeFor("ptt", false, true)).toBe("open");
    expect(gateModeFor("ptt", true, true)).toBe("open");
    expect(gateModeFor("vad", false, true)).toBe("auto");
  });
});
