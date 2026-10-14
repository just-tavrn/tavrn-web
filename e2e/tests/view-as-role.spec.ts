// SPDX-License-Identifier: Apache-2.0
// "View the room as a role" (docs/CLIENT.md, tavrn-web#130): the owner opens the room as @everyone from Room settings
// → Roles. The private channel is gone, the read-only channel's composer is disabled with the reason, a send (Enter)
// and a pasted file are refused on the device with the preview's notice and nothing reaches the node, a deep link into
// the private channel lands on the "hidden" page. Exit restores the owner's view. axe on the banner and the channel.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { scaled } from "./timeouts";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const VIEW = 1n;
const SEND = 2n;

async function axe(page: Page, selector: string) {
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).include(selector).withTags(TAGS).analyze();
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** In-app navigation (a reload would end the preview: it lives in this tab's memory only). */
async function navigateInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("the owner previews the room as @everyone: hidden channel, read-only composer, refused writes, exit", async ({ page, request }) => {
  test.setTimeout(scaled(120_000));
  const owner = await registerViaApi(request, "own");
  const room = await createRoomViaApi(request, owner.token, "Vorschau");
  const auth = { Authorization: `Bearer ${owner.token}` };
  const call = async (method: "post" | "put" | "get", path: string, data?: object) => {
    const resp = await request[method](`${NODE}/api/v1/rooms/${room.id}${path}`, { headers: auth, ...(data ? { data } : {}) });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    return resp.json().catch(() => null);
  };
  const general = (room.channels as { id: string; kind: string }[]).find((c) => c.kind === "text")!;
  const intern = await call("post", "/channels", { kind: "text", name: "intern", encrypted: false });
  const ansagen = await call("post", "/channels", { kind: "text", name: "ansagen", encrypted: false });
  const everyone = ((await call("get", "")).roles as { id: string; is_everyone: boolean }[]).find((r) => r.is_everyone)!.id;
  await call("put", "/overrides", { target_type: "channel", target_id: intern.id, subject_type: "role", subject_id: everyone, allow: "0", deny: VIEW.toString() });
  await call("put", "/overrides", { target_type: "channel", target_id: ansagen.id, subject_type: "role", subject_id: everyone, allow: "0", deny: SEND.toString() });

  // Room settings → Roles → @everyone → "View room as this role".
  await loginAs(page, owner);
  await page.goto(`/rooms/${room.id}/settings/roles`);
  await page.getByTestId("role-list").getByRole("button", { name: "@everyone" }).click();
  await page.getByTestId("view-as-role").click();
  const dialog = page.getByRole("dialog", { name: "Raum als Rolle ansehen" });
  await expect(dialog.getByLabel("Beitrittsdatum")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Vorschau starten" }).click();

  const banner = page.getByTestId("role-preview-banner");
  await expect(banner.getByRole("status")).toContainText("Ansicht als @everyone");
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  await axe(page, "[data-testid='role-preview-banner']");
  await banner.getByRole("button", { name: "Was simuliert wird" }).click();
  await expect(banner.getByTestId("role-preview-approximations")).toBeVisible();

  // The channel list as @everyone: "intern" is gone, "ansagen" is marked read-only for the role.
  await openNavIfMobile(page);
  const nav = page.getByRole("navigation", { name: "Channels" });
  await expect(nav.locator(`[data-channel='${general.id}']`)).toBeVisible();
  await expect(nav.locator(`[data-channel='${intern.id}']`)).toHaveCount(0);
  await expect(nav.locator(`[data-channel='${ansagen.id}']`).getByTestId("channel-restricted")).toBeVisible();

  // The read-only channel: the composer is disabled and says why.
  await nav.locator(`[data-channel='${ansagen.id}']`).getByRole("link").click();
  await expect(page.getByTestId("channel-name")).toHaveText("ansagen");
  await expect(page.getByLabel("Nachricht", { exact: true })).toBeDisabled();
  await expect(page.getByTestId("composer")).toContainText("Du darfst in diesem Channel nicht schreiben.");
  await axe(page, "main");

  // A channel @everyone may write in: the composer follows the role, but a pasted file and a send are refused here.
  await navigateInApp(page, `/rooms/${room.id}/channels/${general.id}`);
  await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled();
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(["hallo"], "notiz.txt", { type: "text/plain" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const refused = page.getByTestId("preview-refused");
  await expect(refused).toContainText("Vorschau nur zum Ansehen");
  await expect(refused).toHaveCount(0, { timeout: scaled(10_000) });
  await box.fill("Als Rolle gesendet?");
  await box.press("Enter");
  await expect(refused).toBeVisible();
  await expect(page.getByTestId("message").filter({ hasText: "Als Rolle gesendet?" })).toHaveCount(0);
  const sent = (await (await request.get(`${NODE}/api/v1/conversations/${general.id}/messages`, { headers: auth })).json()) as { content?: { body?: string } }[];
  expect(sent.some((m) => m.content?.body === "Als Rolle gesendet?")).toBe(false);

  // A deep link into the hidden channel says so.
  await navigateInApp(page, `/rooms/${room.id}/channels/${intern.id}`);
  await expect(page.getByTestId("channel-hidden")).toHaveText("Mitglieder mit dieser Rolle sehen diesen Channel nicht.");

  // Exit: the owner's own view is back (the private channel, the composer of the read-only channel).
  await page.getByTestId("role-preview-exit").click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("channel-name")).toHaveText("intern");
  await openNavIfMobile(page);
  await expect(nav.locator(`[data-channel='${intern.id}']`)).toBeVisible();
  await nav.locator(`[data-channel='${ansagen.id}']`).getByRole("link").click();
  await expect(page.getByTestId("channel-name")).toHaveText("ansagen");
  await expect(page.getByLabel("Nachricht", { exact: true })).toBeEnabled();
});
