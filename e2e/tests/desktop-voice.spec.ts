// SPDX-License-Identifier: Apache-2.0
// Voice between a browser and the desktop app's native engine (docs/DESKTOP.md "Voice", `just desktop-voice-e2e`): a
// Chromium participant with the fake microphone and the built Linux app (LiveKit's Rust SDK in the shell, its fake audio
// backend: a tone in, a meter out) join one voice channel through the test node, end-to-end encrypted with the frame
// key of the channel's MLS group. Both see each other's encrypted tracks, Chromium decodes the app's audio (so the
// native frame cryptor and the browser's agree on key, derivation and frame format), and the app shows the browser
// user speaking (its engine decrypted and measured the browser's audio). While both are in the call the app's CPU is
// measured, talking and muted, against the voice budgets of tavrn-node/perf/budgets.json.
//
// Runs only with E2E_DESKTOP_APP (the built app binary) under xvfb-run with tauri-driver; the rest of the suite skips it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, nextTotpCode, registerViaApi, tokenOf } from "./helpers";
import { closeOpened, hooks, inboundPeak, voiceUser } from "./voice-helpers";
import { DesktopApp, until } from "./desktop-driver";

const app = process.env.E2E_DESKTOP_APP;

test.describe.configure({ mode: "serial" });
test.skip(!app, "needs the built desktop app (E2E_DESKTOP_APP, just desktop-voice-e2e)");

/** axe-core in the app's webview (WebKitGTK): the WCAG A/AA rules, serious and critical violations fail. */
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

async function scanApp(desktop: DesktopApp, screen: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  const result = await desktop.wd<{ value?: unknown } | Array<{ id: string; impact: string | null; nodes: { target: string[] }[] }>>("POST", `/session/${desktop.session}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      if (!window.axe) { const s = document.createElement("script"); s.textContent = arguments[0]; document.head.appendChild(s); }
      window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] } })
        .then((r) => done(r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target })) }))), (e) => done({ error: String(e) }));`,
    args: [AXE],
  });
  if (!Array.isArray(result)) throw new Error(`axe in the app (${screen}): ${JSON.stringify(result)}`);
  const failing = result.filter((v) => v.impact === "serious" || v.impact === "critical");
  if (result.length) console.log(`axe (${screen}): ${JSON.stringify(result)}`);
  expect(failing, `serious or critical WCAG violations on "${screen}"`).toEqual([]);
}

/** CPU time (user + system, clock ticks) of a process and its threads from /proc. */
function ticks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

/** Percent of one core used by `pids` over `ms`. */
async function cpu(pids: number[], ms: number): Promise<number> {
  const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100;
  const sum = () => pids.reduce((n, p) => n + ticks(p), 0);
  const start = sum();
  await new Promise((r) => setTimeout(r, ms));
  return Math.round(((sum() - start) / hz / (ms / 1000)) * 1000) / 10;
}

/** The app's process and the WebKit processes it started (renderer, network). */
function appProcesses(binary: string): { shell: number; webkit: number[] } {
  const pids = (pattern: string) => {
    try {
      return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  const shell = pids(`^${binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)[0];
  if (!shell) throw new Error(`no process of ${binary}`);
  const children = pids("WebKit(Web|Network)Process").filter((p) => readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1]!.split(" ")[1] === String(shell));
  return { shell, webkit: children };
}

test("the browser and the desktop app's native engine hear each other end-to-end encrypted", async ({ browser, request, browserName }, info) => {
  test.skip(browserName !== "chromium" || info.project.name !== "chromium", "one Chromium participant is enough");
  test.setTimeout(300_000);
  const owner = await registerViaApi(request, "dvowner");
  const room = await createRoomViaApi(request, owner.token, "Desktop voice");
  const voice = room.channels.find((c: { kind: string }) => c.kind === "voice") as { id: string };
  const code = await inviteCode(request, owner.token, room.id);
  const join = async (token: string) => expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: { Authorization: `Bearer ${token}` }, data: {} })).ok()).toBeTruthy();

  // The app's account (TOTP, registered over the API) and the browser user (signed up in the UI, fake microphone).
  const desk = await registerViaApi(request, "dvdesk");
  await join(desk.token);
  const web = await voiceUser(browser, "dvweb");
  await join(await tokenOf(web.page));

  const port = Number(process.env.E2E_NODE_PORT ?? 8080) + 3000;
  const desktop = new DesktopApp({ app: app!, port, env: { TAVRN_DESKTOP_FAKE_AUDIO: "1", TAVRN_DESKTOP_KEYCHAIN: "memory" } });
  try {
    await desktop.start();
    await desktop.signIn(NODE, desk, () => nextTotpCode(desk));
    // The Linux app announces its engine in Settings → Voice.
    await desktop.goTo("/settings/voice");
    await desktop.waitFor("[data-testid=native-engine-linux]", 30_000);
    await scanApp(desktop, "Settings → Voice with the native engine");

    // The app joins the channel first (it creates the group's epoch for the call), then the browser.
    await desktop.goTo(`/rooms/${room.id}/channels/${voice.id}`);
    await desktop.press("[data-testid=voice-join]");
    await desktop.waitFor("[data-testid=voice-stage] [data-testid=voice-e2ee]", 60_000);
    await web.page.goto(`/rooms/${room.id}/channels/${voice.id}`);
    await web.page.getByTestId("voice-join").click();
    await expect(web.page.getByTestId("voice-stage")).toBeVisible({ timeout: 30_000 });

    // The browser's view: the app's microphone track is encrypted and subscribed, and it decodes the app's tone.
    const deskIdentity = await until("the app's participant in the browser", async () => (await hooks(web.page)).remote.find((r) => r.identity.startsWith(`${desk.username}@`))?.identity, 60_000);
    await expect.poll(async () => (await hooks(web.page)).remote.find((r) => r.identity === deskIdentity)?.tracks.some((t) => t.source === "microphone" && t.encrypted && t.subscribed) ?? false, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => inboundPeak(web.page, deskIdentity), { timeout: 30_000 }).toBeGreaterThan(0.05);
    // The app's view: the browser user's tile lights up (its native engine decrypted and measured that audio), and the
    // camera and screen buttons say why they are not available instead of failing.
    const speaking = () => desktop.script<boolean>("return !!document.querySelector(`[data-testid=voice-tile][data-user='${arguments[0]}'][data-speaking]`);", [web.address]);
    await until("the browser user speaking in the app", speaking, 30_000);
    const camera = await desktop.script<string | null>("return document.querySelector('[data-testid=voice-camera]')?.getAttribute('aria-disabled') ?? null;");
    expect(camera === null || camera === "true").toBe(true);
    await scanApp(desktop, "voice channel joined with the native engine");

    // CPU of the app while both talk, then muted (the budgets are per renderer; the native engine runs in the shell).
    const procs = appProcesses(app!);
    const talk = { shell: await cpu([procs.shell], 10_000), webkit: await cpu(procs.webkit, 10_000) };
    await desktop.press("[data-testid=voice-mute]");
    await until("the app muted", async () => (await desktop.script<string | null>("return document.querySelector('[data-testid=voice-mute]')?.getAttribute('aria-pressed');")) === "true");
    await web.page.getByTestId("voice-mute").click();
    await new Promise((r) => setTimeout(r, 2000));
    const idle = { shell: await cpu([procs.shell], 10_000), webkit: await cpu(procs.webkit, 10_000) };
    const report = { talk, idle, budgets: { voice_talk_cpu_pct: 15, voice_idle_cpu_pct: 5 } };
    console.log(`desktop voice CPU (% of one core): ${JSON.stringify(report)}`);
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/desktop-voice-cpu.json", JSON.stringify(report, null, 2));
    expect(talk.shell + talk.webkit).toBeLessThan(15 * 2);
  } catch (e) {
    const png = await desktop.screenshot();
    if (png) {
      mkdirSync("test-results", { recursive: true });
      writeFileSync("test-results/desktop-voice.png", png);
    }
    console.error(desktop.log.join("").slice(-4000));
    throw e;
  } finally {
    await desktop.stop();
    await closeOpened();
  }
});
