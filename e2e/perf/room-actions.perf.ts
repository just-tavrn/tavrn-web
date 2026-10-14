// SPDX-License-Identifier: Apache-2.0
// Client cost of room administration and voice joins in a realistic room (how to run: perf.config.ts): ≥ 10 roles, 5 categories,
// 25+ channels incl. voice, 200 encrypted messages in the open channel, 3 members. Every action is measured before and
// after a "view as role" round trip (docs/CLIENT.md). Writes perf/results/<mode>[-<PERF_TAG>].json and prints one line per action.
// Environment: PERF_MODE (dev: the Vite dev server, also logs the query fetches; prod: `vite preview` of the bundle),
// PERF_LATENCY_MS (emulated latency per request), PERF_REPS (repetitions per action, 2), PERF_CPU=1 (CPU profiles),
// PERF_SKIP_PREVIEW=1 (the control run without the preview), PERF_TAG (a suffix of the result file). The node needs
// TAVRN_AUTOMOD_BURST_LIMIT=0 (the setup posts 200 messages in a burst).
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Permission } from "@tavrn/sdk";
import { NODE, createRoomViaApi, inviteCode, registerViaUi, tokenOf } from "../tests/helpers.ts";
import { createGroup, cryptoAccountViaApi, externalJoin, sendEncrypted, type CryptoAccount } from "../tests/crypto-helpers.ts";
import { PerfRecorder, installPageProbe, summarise, type WindowResult } from "./instrument.ts";

const MODE = process.env.PERF_MODE ?? "dev";
const CPU = process.env.PERF_CPU === "1";
const REPS = Number(process.env.PERF_REPS ?? "2");
/** Emulated network latency per request (CDP), milliseconds: how the serial request chains scale on a real link. */
const LATENCY = Number(process.env.PERF_LATENCY_MS ?? "0");

async function api(request: APIRequestContext, token: string, method: "get" | "post" | "put" | "patch", path: string, data?: unknown) {
  for (let attempt = 0; ; attempt++) {
    const resp = await request[method](`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
    if (resp.status() === 429 && attempt < 20) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!resp.ok()) throw new Error(`${method} ${path}: ${resp.status()} ${await resp.text()}`);
    return resp.status() === 204 ? null : resp.json();
  }
}

/** Waits for a DOM condition, checked on every animation frame (expect() polls in 100-1000 ms steps, too coarse). */
async function until(page: Page, predicate: string, timeout = 60_000) {
  await page.waitForFunction(predicate, undefined, { polling: "raf", timeout });
}
const nameIs = (text: string) => `document.querySelector("[data-testid=channel-name]")?.textContent === ${JSON.stringify(text)}`;
const hasMessages = `!!document.querySelector("[data-testid=message]") && document.querySelector("[data-testid=channel-name]")?.textContent === "allgemein"`;
const toast = (text: string) => `[...document.querySelectorAll("[role=status]")].some((e) => e.textContent?.includes(${JSON.stringify(text)}))`;

/** In-app navigation (a reload would reset the client state that is measured). */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** Development builds: every query fetch of TanStack Query with its key (the app's own module instance). */
async function attachQueryLog(page: Page) {
  if (MODE !== "dev") return;
  await page.evaluate(async () => {
    const { queryClient } = await import(/* @vite-ignore */ "/src/lib/queryClient.ts" as string);
    const w = window as unknown as { __perfQueries: { at: number; key: string }[] };
    w.__perfQueries = [];
    queryClient.getQueryCache().subscribe((e: { type: string; action?: { type: string }; query: { queryKey: unknown[] } }) => {
      if (e.type === "updated" && e.action?.type === "fetch") w.__perfQueries.push({ at: performance.now(), key: JSON.stringify(e.query.queryKey).replace(/[0-9A-HJKMNP-TV-Z]{26}/g, ":id") });
    });
  });
}

async function queryFetches(page: Page, from: number): Promise<Record<string, number>> {
  if (MODE !== "dev") return {};
  return page.evaluate((f) => {
    const out: Record<string, number> = {};
    for (const q of (window as unknown as { __perfQueries: { at: number; key: string }[] }).__perfQueries) if (q.at >= f) out[q.key] = (out[q.key] ?? 0) + 1;
    return out;
  }, from);
}

/** Development builds: client state that should be gone after a preview (store, observers, MLS queue latency). */
async function clientState(page: Page) {
  if (MODE !== "dev") return null;
  return page.evaluate(async () => {
    const { queryClient } = await import(/* @vite-ignore */ "/src/lib/queryClient.ts" as string);
    const { useRolePreview } = await import(/* @vite-ignore */ "/src/stores/rolePreview.ts" as string);
    const { getMls } = await import(/* @vite-ignore */ "/src/stores/mls.ts" as string);
    const queries = queryClient.getQueryCache().getAll() as { getObserversCount(): number; queryKey: unknown[]; state: { fetchStatus: string } }[];
    const m = (await getMls()) as unknown as { run<T>(fn: () => Promise<T>): Promise<T> } | null;
    const t0 = performance.now();
    if (m) await m.run(async () => 0);
    const queueWait = performance.now() - t0;
    // The MLS state is exported, encrypted and written as a whole after every group change (`persist`).
    const mm = m as unknown as { client: { exportState(): Uint8Array }; persist(): Promise<void>; deps: { meta: { convs: Record<string, unknown> } } } | null;
    let stateBytes = 0;
    let persistMs = 0;
    if (mm) {
      const bytes = mm.client.exportState();
      stateBytes = bytes.length;
      bytes.fill(0);
      const t1 = performance.now();
      for (let i = 0; i < 5; i++) await m!.run(() => mm.persist());
      persistMs = Math.round(((performance.now() - t1) / 5) * 10) / 10;
    }
    return {
      groups: mm ? Object.keys(mm.deps.meta.convs).length : 0,
      stateBytes,
      persistMs,
      preview: useRolePreview.getState().preview,
      queries: queries.length,
      observers: queries.reduce((a, q) => a + q.getObserversCount(), 0),
      fetching: queries.filter((q) => q.state.fetchStatus === "fetching").map((q) => JSON.stringify(q.queryKey)),
      mlsQueueWaitMs: Math.round(queueWait),
    };
  });
}

test("room administration and voice joins, before and after a role preview", async ({ page, request }) => {
  // ---- Setup (not measured)
  await page.addInitScript(installPageProbe);
  // Before the first load: the realtime socket is opened once, at the start.
  const rec = new PerfRecorder(page);
  const owner = await registerViaUi(page, { prefix: "perfown" });
  const token = await tokenOf(page);
  const room = await createRoomViaApi(request, token, "Perfraum", "invite", { encrypted: true });
  const roomId = room.id as string;
  const general = (room.channels as { id: string; kind: string; name: string }[]).find((c) => c.kind === "text")!;
  const voiceDefault = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "voice");
  const P = Permission as unknown as Record<string, bigint>;
  const roleIds: string[] = [];
  for (let i = 1; i <= 11; i++) {
    const perms = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY | P.CONNECT | P.SPEAK | (i % 2 ? P.ADD_REACTIONS : 0n) | (i % 3 ? P.ATTACH_FILES : 0n) | (i > 8 ? P.MANAGE_MESSAGES : 0n);
    const role = await api(request, token, "post", `/rooms/${roomId}/roles`, { name: `Rolle ${i}`, position: i, permissions: perms.toString(), color: "#33aea6", hoist: i > 9 });
    roleIds.push(role.id);
  }
  const detail = await api(request, token, "get", `/rooms/${roomId}`);
  const everyone = (detail.roles as { id: string; is_everyone: boolean }[]).find((r) => r.is_everyone)!.id;
  const categories: string[] = [];
  const voices: string[] = voiceDefault ? [voiceDefault.id] : [];
  const texts: string[] = [];
  for (let c = 1; c <= 5; c++) {
    const cat = await api(request, token, "post", `/rooms/${roomId}/categories`, { name: `Bereich ${c}` });
    categories.push(cat.id);
    for (const [kind, name] of [["text", `text-${c}a`], ["text", `text-${c}b`], ["announcement", `ansagen-${c}`], ["voice", `Sprache ${c}`], ["text", `text-${c}c`]] as const) {
      const ch = await api(request, token, "post", `/rooms/${roomId}/channels`, { kind, name, category_id: cat.id });
      (kind === "voice" ? voices : texts).push(ch.id);
    }
    // Category overrides: @everyone loses reactions, one role regains them; every second category is private.
    await api(request, token, "put", `/rooms/${roomId}/overrides`, { target_type: "category", target_id: cat.id, subject_type: "role", subject_id: everyone, allow: "0", deny: (P.ADD_REACTIONS | (c % 2 ? 0n : P.VIEW_CHANNEL)).toString() });
    await api(request, token, "put", `/rooms/${roomId}/overrides`, { target_type: "category", target_id: cat.id, subject_type: "role", subject_id: roleIds[c]!, allow: (P.ADD_REACTIONS | P.VIEW_CHANNEL).toString(), deny: "0" });
  }
  for (let i = 0; i < 8; i++) {
    await api(request, token, "put", `/rooms/${roomId}/overrides`, { target_type: "channel", target_id: texts[i * 2]!, subject_type: "role", subject_id: roleIds[i]!, allow: "0", deny: P.SEND_MESSAGES.toString() });
  }
  const code = await inviteCode(request, token, roomId);
  const members: CryptoAccount[] = [];
  for (const prefix of ["perfa", "perfb"]) {
    const m = await cryptoAccountViaApi(request, prefix);
    await api(request, m.token, "post", `/invites/${code}/join`, {});
    members.push(m);
  }
  // Two members get roles, so the member list and role colours are not trivial.
  for (const [n, m] of members.entries()) await api(request, token, "patch", `/rooms/${roomId}/members/${m.userId}`, { roles: [roleIds[n]!, roleIds[n + 5]!] });

  // The owner opens the channel: the client creates its MLS group. Then both members join it and post 200 messages.
  await page.goto(`/rooms/${roomId}/channels/${general.id}`);
  await expect(page.getByTestId("channel-name")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await request.get(`${NODE}/api/v1/conversations/${general.id}/mls/group-info`, { headers: { Authorization: `Bearer ${members[0]!.token}` } })).status(), { timeout: 60_000 })
    .toBe(200);
  await externalJoin(request, members[0]!, general.id);
  for (let i = 0; i < 100; i++) await sendEncrypted(request, members[0]!, general.id, `Nachricht ${i} von A: **fett**, _kursiv_, \`code\` und ein Link https://example.org/${i}`);
  await externalJoin(request, members[1]!, general.id);
  for (let i = 0; i < 100; i++) await sendEncrypted(request, members[1]!, general.id, `Antwort ${i} von B mit etwas mehr Text, damit die Zeilen unterschiedlich hoch werden. ${"lorem ipsum ".repeat(i % 7)}`);
  const states: Record<string, unknown> = {};
  states["setup: before the other groups"] = await clientState(page);
  // The other channels are in use too: the members create their groups (the owner's client joins them in the background).
  let groups = 0;
  for (const id of texts) {
    for (const m of members) {
      if (await createGroup(request, m, id).then(() => true, () => false)) {
        groups++;
        break;
      }
    }
  }
  console.log(`groups created by members: ${groups} of ${texts.length}`);
  // What the room detail (`GET /rooms/{id}`, refetched after every change) is made of.
  const full = await api(request, token, "get", `/rooms/${roomId}`);
  console.log("room detail bytes:", JSON.stringify(full).length, JSON.stringify(Object.fromEntries(Object.entries(full).map(([k, v]) => [k, `${JSON.stringify(v).length}${Array.isArray(v) ? ` (${v.length})` : ""}`]).filter(([, v]) => Number(String(v).split(" ")[0]) > 200))));
  // A fresh load with the full room, as after a restart.
  await page.goto(`/rooms/${roomId}/channels/${general.id}`);
  await expect(page.getByTestId("message").first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(15000);
  await attachQueryLog(page);
  if (LATENCY) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  }

  const results: (WindowResult & { phase: string; queries: Record<string, number> })[] = [];
  const nameOf = (id: string) => (detail.roles as { id: string; name: string }[]).find((r) => r.id === id)?.name ?? id;
  async function run(phase: string, name: string, action: () => Promise<void>, opts: { settleMs?: number; cpu?: boolean } = {}) {
    const from = await page.evaluate(() => performance.now());
    const r = await rec.measure(`${phase}: ${name}`, action, { ...opts, cpu: CPU && opts.cpu });
    results.push({ ...r, phase, queries: await queryFetches(page, from) });
    console.log(summarise(r));
    const grouped: Record<string, number> = {};
    for (const q of r.requests) grouped[`${q.method} ${q.path}`] = (grouped[`${q.method} ${q.path}`] ?? 0) + 1;
    console.log(`    http ${JSON.stringify(grouped)}\n    ws ${JSON.stringify(r.wsEvents)}\n    queries ${JSON.stringify(results.at(-1)!.queries)}`);
  }
  const noToast = async (text: string) => expect(page.getByRole("status").filter({ hasText: text })).toHaveCount(0, { timeout: 20_000 });
  const roomPath = `/rooms/${roomId}`;
  let counter = 0;

  async function phase(label: string) {
    states[`${label}: state`] = await clientState(page);
    await run(label, "idle 5 s", async () => undefined, { settleMs: 5000 });
    // Channel switch: another text channel and back to the one with 200 messages.
    await run(label, "switch channel", async () => {
      await go(page, `${roomPath}/channels/${texts[0]}`);
      await until(page, nameIs("text-1a"));
    });
    await run(label, "open channel with 200 messages", async () => {
      await go(page, `${roomPath}/channels/${general.id}`);
      await until(page, hasMessages);
    });
    // Room settings → Roles.
    await run(label, "open settings/roles", async () => {
      await go(page, `${roomPath}/settings/roles`);
      await until(page, `!!document.querySelector("[data-testid=role-editor]")`);
    });
    for (let rep = 0; rep < REPS; rep++) {
      const roleId = roleIds[3]!;
      await page.getByTestId("role-list").getByRole("button", { name: nameOf(roleId), exact: true }).click();
      await noToast("Rolle gespeichert");
      await page.locator(`#role-${roleId}-ADD_REACTIONS`).click();
      await run(label, "save role (permission)", async () => {
        await page.getByTestId("role-editor").getByRole("button", { name: "Speichern", exact: true }).click();
        await until(page, toast("Rolle gespeichert"));
      }, { cpu: rep === 0 });
    }
    // Room settings → Channels: a new category, then a channel override.
    await go(page, `${roomPath}/settings/channels`);
    await expect(page.getByRole("textbox", { name: "Neue Kategorie" })).toBeVisible();
    const catName = `Kat ${label} ${++counter}`;
    await page.getByRole("textbox", { name: "Neue Kategorie" }).fill(catName);
    await run(label, "create category", async () => {
      await page.getByRole("textbox", { name: "Neue Kategorie" }).press("Enter");
      await until(page, `[...document.querySelectorAll("[data-testid=category-permissions]")].some((e) => e.textContent?.includes(${JSON.stringify(catName)}))`);
    });
    await page.locator("button", { hasText: "text-2a" }).first().click();
    for (let rep = 0; rep < REPS; rep++) {
      await noToast("Berechtigungen gespeichert");
      const row = page.getByTestId("override-tristate").locator("[data-permission='ADD_REACTIONS']");
      await row.getByRole("radio").nth(rep % 2 === 0 ? 0 : 1).click();
      await run(label, "save channel override", async () => {
        await page.getByRole("button", { name: "Berechtigungen speichern", exact: true }).click();
        await until(page, toast("Berechtigungen gespeichert"));
      }, { cpu: rep === 0 });
    }
    // Back in the room: a new channel through the sidebar dialog.
    await go(page, `${roomPath}/channels/${general.id}`);
    await expect(page.getByTestId("message").first()).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Channels" });
    await nav.getByRole("button", { name: "Channel erstellen" }).click();
    const chName = `neu-${label.replace(/\W/g, "")}-${++counter}`;
    await page.locator("input[name='channel_name']").fill(chName);
    await run(label, "create channel", async () => {
      await page.getByRole("dialog").getByRole("button", { name: "Erstellen", exact: true }).click();
      await until(page, `[...document.querySelectorAll("[data-testid=channel-row]")].some((e) => e.textContent?.includes(${JSON.stringify(chName)}))`);
    });
    // Voice: click until connected, then leave.
    for (let rep = 0; rep < REPS; rep++) {
      const target = voices[rep % voices.length]!;
      await run(label, "voice join (click → connected)", async () => {
        await nav.locator(`[data-testid='voice-channel'][data-channel='${target}'] [data-testid='voice-channel-link']`).click();
        await until(page, `document.querySelector("[data-testid=voice-bar]")?.getAttribute("data-status") === "connected"`);
      }, { cpu: rep === 0, settleMs: 3000 });
      await run(label, "voice leave", async () => {
        await page.getByTestId("voice-bar-leave").click();
        await until(page, `!document.querySelector("[data-testid=voice-bar]")`);
      });
      await go(page, `${roomPath}/channels/${general.id}`);
      await expect(page.getByTestId("message").first()).toBeVisible();
    }
  }

  async function previewRoundTrip() {
  await go(page, `${roomPath}/settings/roles`);
  await page.getByTestId("role-list").getByRole("button", { name: "@everyone" }).click();
  await page.getByTestId("view-as-role").click();
  const dialog = page.getByRole("dialog", { name: "Raum als Rolle ansehen" });
  await run("preview", "start preview (@everyone)", async () => {
    await dialog.getByRole("button", { name: "Vorschau starten" }).click();
    await until(page, `!!document.querySelector("[data-testid=role-preview-banner]") && !!document.querySelector("[data-testid=channel-name]")`);
  });
  await run("preview", "switch channel in preview", async () => {
    await go(page, `${roomPath}/channels/${texts[0]}`);
    await until(page, nameIs("text-1a"));
  });
  await run("preview", "back to 200 messages in preview", async () => {
    await go(page, `${roomPath}/channels/${general.id}`);
    // The preview cuts the encrypted history at the simulated join date: the name is the visible result.
    await until(page, nameIs("allgemein"));
  });
  await run("preview", "idle 5 s in preview", async () => undefined, { settleMs: 5000 });
  await run("preview", "exit preview", async () => {
    await page.getByTestId("role-preview-exit").click();
    await until(page, `!document.querySelector("[data-testid=role-preview-banner]")`);
  });

  }

  await phase("before");

  // ---- The role preview round trip (PERF_SKIP_PREVIEW=1: the control run without it)
  if (process.env.PERF_SKIP_PREVIEW !== "1") await previewRoundTrip();
  await phase("after");
  states["end: state"] = await clientState(page);

  // Voice right after a reload (the background group joins of a fresh start run at the same time), then once settled.
  const nav = page.getByRole("navigation", { name: "Channels" });
  const voiceJoin = async (target: string) => {
    await nav.locator(`[data-testid='voice-channel'][data-channel='${target}'] [data-testid='voice-channel-link']`).click();
    await until(page, `document.querySelector("[data-testid=voice-bar]")?.getAttribute("data-status") === "connected"`);
  };
  const voiceLeave = async () => {
    await page.getByTestId("voice-bar-leave").click();
    await until(page, `!document.querySelector("[data-testid=voice-bar]")`);
  };
  await page.reload();
  await until(page, hasMessages);
  states["reload: state at first paint"] = await clientState(page);
  await attachQueryLog(page);
  await run("reload", "voice join right after load", () => voiceJoin(voices[1]!), { settleMs: 3000, cpu: true });
  await run("reload", "voice leave", voiceLeave);
  await page.waitForTimeout(20_000);
  states["reload: state after 20 s"] = await clientState(page);
  await run("reload", "voice join 20 s after load", () => voiceJoin(voices[2]!), { settleMs: 3000 });
  await run("reload", "voice leave", voiceLeave);

  mkdirSync("perf/results", { recursive: true });
  writeFileSync(`perf/results/${MODE}${CPU ? "-cpu" : ""}${LATENCY ? `-lat${LATENCY}` : ""}${process.env.PERF_SKIP_PREVIEW === "1" ? "-nopreview" : ""}${process.env.PERF_TAG ? `-${process.env.PERF_TAG}` : ""}.json`, JSON.stringify({ mode: MODE, owner: owner.username, roomId, results, states, sockets: rec.sockets }, null, 2));
  console.log("sockets", JSON.stringify(rec.sockets));
  console.log(JSON.stringify(states, null, 2));
});
