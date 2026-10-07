// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Gate, LevelMeter, dbfs } from "./gate";

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
