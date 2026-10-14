// SPDX-License-Identifier: Apache-2.0
// What a "view as role" round trip leaves behind (how to run: perf.config.ts): mounted component instances and how often the channel
// list renders for one room update (a role change made over the API), before and after the preview.
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "../tests/helpers.ts";
import { PerfRecorder, installPageProbe } from "./instrument.ts";

async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

const instances = (page: Page) => page.evaluate(() => (window as unknown as { __perfProbe: { instances: () => Record<string, number> } }).__perfProbe.instances());

test("role preview residue", async ({ page, request }) => {
  await page.addInitScript(installPageProbe);
  const rec = new PerfRecorder(page);
  const owner = await registerViaApi(request, "resid");
  const room = await createRoomViaApi(request, owner.token, "Rest");
  const auth = { Authorization: `Bearer ${owner.token}` };
  for (let i = 0; i < 6; i++) await request.post(`${NODE}/api/v1/rooms/${room.id}/channels`, { headers: auth, data: { kind: i % 3 === 2 ? "voice" : "text", name: `k${i}`, encrypted: false } });
  const role = await (await request.post(`${NODE}/api/v1/rooms/${room.id}/roles`, { headers: auth, data: { name: "Gast", position: 1, permissions: "0" } })).json();
  const general = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "text")!;
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/channels/${general.id}`);
  await expect(page.getByTestId("channel-name")).toBeVisible();
  await page.waitForTimeout(3000);

  let n = 0;
  const roleChange = () =>
    rec.measure(`role change over the API #${++n}`, async () => {
      const resp = await request.patch(`${NODE}/api/v1/rooms/${room.id}/roles/${role.id}`, { headers: auth, data: { permissions: String(n % 2 ? 16 : 0) } });
      expect(resp.ok()).toBeTruthy();
    }, { settleMs: 1500 });
  const show = (label: string, r: Awaited<ReturnType<typeof roleChange>>) => {
    console.log(label, "commits", r.commits.count, "rendered", r.commits.rendered, JSON.stringify(Object.fromEntries(r.commits.top.filter(([k]) => /ChannelSidebar|ChannelLink|VoiceChannelRow|ConversationView|MessageList|RoomRail|AppLayout|Composer/.test(k)))));
    console.log("   http", JSON.stringify(r.requests.map((q) => `${q.at}ms ${q.method} ${q.path}`)), "ws", JSON.stringify(r.wsEvents));
  };

  const before = await instances(page);
  show("before preview:", await roleChange());
  show("before preview:", await roleChange());

  await go(page, `/rooms/${room.id}/settings/roles`);
  await page.getByTestId("role-list").getByRole("button", { name: "@everyone" }).click();
  await page.getByTestId("view-as-role").click();
  await page.getByRole("dialog", { name: "Raum als Rolle ansehen" }).getByRole("button", { name: "Vorschau starten" }).click();
  await expect(page.getByTestId("role-preview-banner")).toBeVisible();
  await page.waitForTimeout(1000);
  const during = await instances(page);
  await page.getByTestId("role-preview-exit").click();
  await expect(page.getByTestId("role-preview-banner")).toHaveCount(0);
  await page.waitForTimeout(1500);
  const after = await instances(page);
  show("after preview:", await roleChange());
  show("after preview:", await roleChange());
  // Back in the channel the preview had opened, then elsewhere: does the double render follow the route?
  await go(page, `/rooms/${room.id}/channels/${general.id}`);
  await page.waitForTimeout(1500);
  show("after preview, channel again:", await roleChange());

  const diff = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] ?? 0) !== (b[k] ?? 0)).map((k) => [k, `${a[k] ?? 0} → ${b[k] ?? 0}`]));
  console.log("instances before → during preview:", JSON.stringify(diff(before, during)));
  console.log("instances before → after exit:", JSON.stringify(diff(before, after)));
  console.log("location after exit:", await page.evaluate(() => location.pathname));
});
