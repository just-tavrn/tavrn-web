// SPDX-License-Identifier: Apache-2.0
// MEASUREMENT ONLY (perfvoicefix, not committed; from perf/voice-analysis): latency of joining a voice channel, stage by stage, against a release node that
// serves the instrumented production bundle (`vj:*` performance marks of web/src/voice/joinTimings.ts). Writes one JSON
// record per join to $PERF_OUT and prints a timeline. Not part of the suite.
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, openNavIfMobile, registerViaUi, tokenOf } from "../tests/helpers";
import { speechWav } from "../tests/fake-audio";

const OUT = process.env.PERF_OUT ?? join(tmpdir(), "perfvoice.jsonl");
const FAKE_VOICE = join(tmpdir(), "tavrn-perfvoice.wav");
writeFileSync(FAKE_VOICE, speechWav(5));
const FAKE_MEDIA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${FAKE_VOICE}`, "--autoplay-policy=no-user-gesture-required"];
test.use({ launchOptions: { args: FAKE_MEDIA }, permissions: ["microphone", "camera"] });

/** Wraps fetch, WebSocket and RTCPeerConnection to log their timings in the page's clock (performance.now()). */
function probes() {
  const w = window as unknown as Record<string, unknown>;
  const fetchLog: unknown[] = [];
  const wsLog: unknown[] = [];
  const pcLog: unknown[] = [];
  const pcs: RTCPeerConnection[] = [];
  w.__fetchLog = fetchLog;
  w.__wsLog = wsLog;
  w.__pcLog = pcLog;
  w.__pcs = pcs;
  const strip = (u: string) => u.replace(location.origin, "").replace(/access_token=[^&]+/, "access_token=…");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const rec: Record<string, unknown> = { m: method, u: strip(url), s: performance.now() };
    fetchLog.push(rec);
    try {
      const r = await nativeFetch(input, init);
      rec.e = performance.now();
      rec.st = r.status;
      return r;
    } catch (e) {
      rec.e = performance.now();
      rec.st = "error";
      throw e;
    }
  };
  const NativeWs = window.WebSocket;
  class LoggedWs extends NativeWs {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const rec: Record<string, unknown> = { u: strip(String(url)), s: performance.now() };
      wsLog.push(rec);
      this.addEventListener("open", () => (rec.open = performance.now()));
      this.addEventListener("close", () => (rec.close = performance.now()));
      let first = true;
      this.addEventListener("message", () => {
        if (first) rec.firstMsg = performance.now();
        first = false;
      });
    }
  }
  window.WebSocket = LoggedWs;
  const NativePc = window.RTCPeerConnection;
  class LoggedPc extends NativePc {
    constructor(config?: RTCConfiguration) {
      super(config);
      const id = pcs.push(this);
      const log = (k: string, v: string) => pcLog.push({ pc: id, k, v, t: performance.now() });
      log("create", `iceServers=${config?.iceServers?.length ?? 0} policy=${config?.iceTransportPolicy ?? "all"}`);
      this.addEventListener("icegatheringstatechange", () => log("gather", this.iceGatheringState));
      this.addEventListener("iceconnectionstatechange", () => log("ice", this.iceConnectionState));
      this.addEventListener("connectionstatechange", () => log("conn", this.connectionState));
      this.addEventListener("signalingstatechange", () => log("sig", this.signalingState));
      this.addEventListener("icecandidate", (e) => log("localcand", e.candidate ? e.candidate.candidate.split(" ").slice(2, 8).join(" ") : "end"));
    }
  }
  window.RTCPeerConnection = LoggedPc;
  try {
    performance.setResourceTimingBufferSize(10000);
  } catch {
    /* fine */
  }
}

const opened: BrowserContext[] = [];
test.afterAll(async () => {
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
});

async function user(browser: Browser, prefix: string): Promise<{ page: Page; address: string }> {
  const context = await browser.newContext({ ...test.info().project.use, permissions: ["microphone", "camera"] });
  opened.push(context);
  await context.addInitScript(probes);
  await context.addInitScript(() => localStorage.setItem("tavrn.debug.voice", "1"));
  // Cues on (the owner hears the join cue); nothing else changed.
  const page = await context.newPage();
  // Production-like round trips to the node (Cloudflare edge → origin): CDP adds this latency to every request.
  const latency = Number(process.env.PERF_LATENCY ?? 0);
  if (latency > 0) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
  }
  page.on("console", (m) => {
    if (m.type() === "error" || m.text().startsWith("voice:")) console.log(`[${prefix}] ${m.type()}: ${m.text().slice(0, 300)}`);
  });
  const account = await registerViaUi(page, { prefix });
  return { page, address: account.address };
}

async function navigateInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function reset(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown[]> & { __vj?: { writes: unknown[]; notes: unknown[] } };
    performance.clearMarks();
    performance.clearResourceTimings();
    (w.__fetchLog as unknown[]).length = 0;
    (w.__wsLog as unknown[]).length = 0;
    (w.__pcLog as unknown[]).length = 0;
    if (w.__vj) {
      w.__vj.writes.length = 0;
      w.__vj.notes.length = 0;
    }
  });
}

interface Collected {
  marks: { n: string; t: number; d: unknown }[];
  fetches: { m: string; u: string; s: number; e?: number; st?: unknown }[];
  ws: { u: string; s: number; open?: number; firstMsg?: number }[];
  pcs: { pc: number; k: string; v: string; t: number }[];
  writes: { name: string; bytes: number; ms: number; at: number }[];
  pairs: unknown[];
}

async function collect(page: Page): Promise<Collected> {
  return page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown> & { __vj?: { writes: unknown[] } };
    const pairs: unknown[] = [];
    for (const pc of (w.__pcs as RTCPeerConnection[]) ?? []) {
      if (pc.connectionState !== "connected") continue;
      const stats = await pc.getStats();
      const all = new Map<string, Record<string, unknown>>();
      stats.forEach((s: Record<string, unknown>) => all.set(s.id as string, s));
      for (const s of all.values()) {
        if (s.type !== "transport" || typeof s.selectedCandidatePairId !== "string") continue;
        const pair = all.get(s.selectedCandidatePairId);
        const l = pair && all.get(pair.localCandidateId as string);
        const r = pair && all.get(pair.remoteCandidateId as string);
        pairs.push({ local: l?.candidateType, remote: r?.candidateType, proto: r?.protocol, rtt: pair?.currentRoundTripTime });
      }
    }
    return {
      marks: performance.getEntriesByType("mark").filter((m) => m.name.startsWith("vj:")).map((m) => ({ n: m.name.slice(3), t: m.startTime, d: (m as PerformanceMark).detail })),
      fetches: JSON.parse(JSON.stringify(w.__fetchLog)),
      ws: JSON.parse(JSON.stringify(w.__wsLog)),
      pcs: JSON.parse(JSON.stringify(w.__pcLog)),
      writes: JSON.parse(JSON.stringify(w.__vj?.writes ?? [])),
      pairs,
    };
  });
}

function report(label: string, c: Collected, origin = "click") {
  const t0 = c.marks.find((m) => m.n === origin)?.t ?? c.marks[0]?.t ?? 0;
  const rel = (t: number | undefined) => (t === undefined ? "-" : (t - t0).toFixed(0).padStart(6));
  const lines: string[] = [`==== ${label}`];
  let prev = t0;
  for (const m of c.marks) {
    lines.push(`  ${rel(m.t)} ms  (+${(m.t - prev).toFixed(0).padStart(5)})  ${m.n}${m.d ? " " + JSON.stringify(m.d) : ""}`);
    prev = m.t;
  }
  lines.push("  -- requests");
  for (const f of c.fetches) lines.push(`  ${rel(f.s)} → ${rel(f.e)}  (${((f.e ?? f.s) - f.s).toFixed(0).padStart(4)} ms) ${f.m} ${f.u} ${f.st ?? ""}`);
  lines.push("  -- websockets");
  for (const s of c.ws) lines.push(`  ${rel(s.s)} open ${rel(s.open)} first ${rel(s.firstMsg)}  ${s.u.slice(0, 80)}`);
  lines.push("  -- peer connections");
  for (const p of c.pcs) if (p.k !== "localcand") lines.push(`  ${rel(p.t)} pc${p.pc} ${p.k}=${p.v}`);
  const cands = c.pcs.filter((p) => p.k === "localcand");
  lines.push(`  local candidates: ${cands.length} (last at ${rel(cands.at(-1)?.t)})`);
  lines.push(`  selected pairs: ${JSON.stringify(c.pairs)}`);
  lines.push(`  -- secret writes: ${c.writes.map((x) => `${x.name} ${(x.bytes / 1024).toFixed(0)}KiB ${x.ms.toFixed(0)}ms @${rel(x.at)}`).join("; ")}`);
  console.log(lines.join("\n"));
  appendFileSync(OUT, JSON.stringify({ label: `${test.info().project.name} ${label}`, ...c, t0 }) + "\n");
}

const voiceLink = (page: Page) => page.getByRole("link", { name: "Sprachkanal Sprache" });

async function measureJoin(page: Page, label: string, roomId: string, settle = 1500) {
  // The room's channel list must be on screen (in-app navigation keeps the app state).
  if (!page.url().includes(`/rooms/${roomId}`) || page.url().includes("/settings")) await navigateInApp(page, `/rooms/${roomId}`);
  await openNavIfMobile(page);
  await expect(voiceLink(page)).toBeVisible();
  await page.waitForTimeout(settle);
  await reset(page);
  await voiceLink(page).click();
  await page.waitForFunction(() => performance.getEntriesByName("vj:state_reported").length > 0 || performance.getEntriesByName("vj:join_resolved").length > 0, null, { timeout: 60_000 });
  await expect(page.getByTestId("voice-e2ee")).toBeVisible();
  await page.waitForTimeout(500);
  report(label, await collect(page));
}

async function measureLeave(page: Page, label: string) {
  await reset(page);
  await page.getByTestId("voice-leave").click();
  await page.waitForFunction(() => performance.getEntriesByName("vj:leave_done").length > 0, null, { timeout: 30_000 });
  report(`${label} (leave)`, await collect(page), "leave_start");
}

/** The MLS state: size and the cost of one export (what every persist does before the encrypted write). */
async function stateCost(page: Page, label: string) {
  const r = await page.evaluate(async () => {
    const get = (globalThis as unknown as { __vjMls?: () => Promise<{ client: { exportState(): Uint8Array } } | null> }).__vjMls;
    if (!get) return null;
    const m = await get();
    if (!m) return null;
    const t = performance.now();
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const s = m.client.exportState();
      bytes = s.length;
      s.fill(0);
    }
    return { bytes, exportMs: (performance.now() - t) / 5 };
  });
  console.log(`==== state ${label}: ${JSON.stringify(r)}`);
  appendFileSync(OUT, JSON.stringify({ label: `state ${label}`, state: r }) + "\n");
}

test("voice join latency", async ({ browser, request }) => {
  const a = await user(browser, "pva");
  const token = await tokenOf(a.page);
  const room = await createRoomViaApi(request, token, "Perf", "invite", { encrypted: true });
  const roomId = room.id as string;
  const code = await inviteCode(request, token, roomId);
  await a.page.goto(`/rooms/${roomId}`);

  // 1. First join ever: the group is created, the session module is loaded, LiveKit's room does not exist yet.
  await measureJoin(a.page, "S1 first join (group creation, cold module, LK room absent)", roomId);
  await measureLeave(a.page, "S1");
  // 2. Rejoin right after leaving: LiveKit's room still exists (departure_timeout 20 s).
  await a.page.waitForTimeout(2000);
  await measureJoin(a.page, "S2 rejoin after 2 s (LK room exists)", roomId);
  await measureLeave(a.page, "S2");
  await a.page.waitForTimeout(2000);
  await measureJoin(a.page, "S2b rejoin after 2 s again", roomId);
  await measureLeave(a.page, "S2b");

  // 4. Right after a page load: six encrypted text channels this device never opened (the background group joins
  // probe them, one every 400 ms), the join as soon as the channel list shows the voice channel.
  for (let i = 0; i < 6; i++) {
    const resp = await request.post(`${NODE}/api/v1/rooms/${roomId}/channels`, { headers: { Authorization: `Bearer ${token}` }, data: { kind: "text", name: `kanal-${i}` } });
    expect(resp.ok(), await resp.text()).toBeTruthy();
  }
  await a.page.reload();
  await openNavIfMobile(a.page);
  await measureJoin(a.page, "S4 join right after a page load (6 unjoined channels)", roomId, 0);
  await measureLeave(a.page, "S4");

  // 5. Two other participants in the channel.
  const others = [await user(browser, "pvb"), await user(browser, "pvc")];
  for (const o of others) {
    const resp = await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${await tokenOf(o.page)}` }, data: {} });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    await o.page.goto(`/rooms/${roomId}`);
    await measureJoin(o.page, `S5-other join of another member`, roomId);
  }
  await a.page.waitForTimeout(2000);
  await measureJoin(a.page, "S5 join with 2 others in the channel", roomId);
  await measureLeave(a.page, "S5");
  await a.page.waitForTimeout(2000);
  await measureJoin(a.page, "S5b join with 2 others again", roomId);
  await measureLeave(a.page, "S5b");
  for (const o of others) await measureLeave(o.page, `others`);

  // 12. A member leaves a room (mls.remove_needed): the owner's background cleanup of the voice channel's group, and a
  // join of that channel 0.5 s later.
  const [b, c] = others;
  const cToken = await tokenOf(c.page);
  const r2 = await createRoomViaApi(request, cToken, "Perf2", "invite", { encrypted: true });
  const r2Id = r2.id as string;
  const code2 = await inviteCode(request, cToken, r2Id);
  for (const u of [a, b]) {
    const resp = await request.post(`${NODE}/api/v1/invites/${code2}/join`, { headers: { Authorization: `Bearer ${await tokenOf(u.page)}` }, data: {} });
    expect(resp.ok(), await resp.text()).toBeTruthy();
  }
  for (const u of [c, a, b]) {
    await navigateInApp(u.page, `/rooms/${r2Id}`);
    await measureJoin(u.page, `S12-prep`, r2Id);
    await measureLeave(u.page, `S12-prep`);
  }
  await navigateInApp(c.page, `/rooms/${r2Id}`);
  await openNavIfMobile(c.page);
  await expect(voiceLink(c.page)).toBeVisible();
  const left = await request.post(`${NODE}/api/v1/rooms/${r2Id}/leave`, { headers: { Authorization: `Bearer ${await tokenOf(b.page)}` }, data: {} });
  expect(left.ok(), await left.text()).toBeTruthy();
  await measureJoin(c.page, "S12 owner joins 0.5 s after a member left the room (remove_needed cleanup running)", r2Id, 500);
  await measureLeave(c.page, "S12");
  await c.page.waitForTimeout(2000);
  await measureJoin(c.page, "S12b owner rejoins (leaf gone)", r2Id);
  await measureLeave(c.page, "S12b");
});
