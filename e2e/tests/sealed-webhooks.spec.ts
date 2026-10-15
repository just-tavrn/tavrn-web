// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";
import sodium from "libsodium-wrappers";
import { NODE, openNavIfMobile, registerViaUi, tokenOf, openRoomInvite, newPage, message, closePages } from "./helpers";
import { scaled } from "./timeouts";

test.afterEach(closePages);

// Write-only webhooks in encrypted channels (APPLICATIONS.md §6.1a, ENCRYPTION.md §5b): created in the room settings
// with the sealing mode, a service seals with libsodium (`crypto_box_seal`) to the channel's inbox key, the node seals
// plaintext posts of node-sealed webhooks and stores only sealed boxes, members read both with the WEBHOOK badge and a
// lock, and a member who joins later reads them through the history keys.

const CRYPTO = { timeout: scaled(30_000) };
const B64 = () => sodium.base64_variants.URLSAFE_NO_PADDING;

const pathOf = (url: string) => url.slice(url.indexOf("/api/v1/"));

async function closeDrawers(page: Page) {
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (!(await overlay.isVisible())) return;
  const members = (await page.getByTestId("members-drawer").getAttribute("data-open")) === "true";
  await overlay.click({ position: { x: members ? 8 : (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
}

async function send(page: Page, text: string) {
  await closeDrawers(page);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: scaled(15_000) });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(message(page, text)).toBeVisible();
}

/** Creates a webhook in the room settings; returns the execution URL and (sender mode) the key URL. */
async function createWebhook(page: Page, roomId: string, name: string, mode: "sender" | "node") {
  await page.goto(`/rooms/${roomId}/settings/webhooks`);
  await page.getByTestId("webhook-name").fill(name);
  // The only text channel is encrypted: the mode choice is shown with its explanation, sender sealing preselected.
  const choice = page.getByTestId("webhook-sealing");
  await expect(choice).toBeVisible();
  await expect(choice).toContainText("Der Knoten sieht den Text nie");
  await expect(choice).toContainText("der Betreiber des Knotens könnte ihn also lesen");
  await expect(page.getByTestId("webhook-sealing-sender")).toBeChecked();
  if (mode === "node") await page.getByTestId("webhook-sealing-node").check();
  await page.getByTestId("webhook-create").click();
  const url = await page.getByTestId("webhook-url").inputValue();
  const inbox = mode === "sender" ? await page.getByTestId("webhook-inbox-url").inputValue() : null;
  if (mode === "node") await expect(page.getByTestId("webhook-inbox-url")).toHaveCount(0);
  await page.getByTestId("webhook-url-done").click();
  const row = page.getByTestId("webhook-row").filter({ hasText: name });
  await expect(row.getByTestId("webhook-mode")).toContainText(mode === "node" ? "vom Knoten versiegelt" : "vom Dienst versiegelt");
  // The creating device published the channel's inbox key: the webhook is usable right away.
  await expect(row.getByTestId("webhook-pending")).toHaveCount(0);
  return { url, inbox };
}

/** What a service does in sender mode: fetch the key, seal with libsodium, post `{ sealed, epoch }`. */
async function postSealed(page: Page, url: string, inbox: string, payload: unknown) {
  await sodium.ready;
  const key = await (await page.request.get(`${NODE}${pathOf(inbox)}`)).json();
  expect(key.algorithm).toBe("x25519-xsalsa20poly1305-sealedbox");
  const box = sodium.crypto_box_seal(JSON.stringify(payload), sodium.from_base64(key.public_key, B64()));
  const resp = await page.request.post(`${NODE}${pathOf(url)}?wait=true`, { data: { sealed: sodium.to_base64(box, B64()), epoch: key.epoch } });
  expect(resp.status(), await resp.text()).toBe(200);
  return { message: await resp.json(), epoch: key.epoch as number };
}

test.describe("Sealed webhooks in encrypted channels", () => {
  test("sealed by the service and by the node: members read both, so does a member who joined later", async ({ browser, page }) => {
    test.setTimeout(scaled(240_000));
    await registerViaUi(page, { prefix: "alice" });
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Versiegelt");
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("encrypted-marker")).toBeVisible();
    const roomUrl = page.url();
    const roomId = roomUrl.split("/rooms/")[1]!.split("/")[0]!;
    const channelId = roomUrl.split("/channels/")[1]!;
    await send(page, "Alte Nachricht eins");
    const auth = { Authorization: `Bearer ${await tokenOf(page)}` };
    const policy = await page.request.patch(`${NODE}/api/v1/rooms/${roomId}/channels/${channelId}`, { headers: auth, data: { history_for_new_members: "all" } });
    expect(policy.ok(), await policy.text()).toBeTruthy();

    // Sender mode: the service seals itself; plaintext is refused.
    const ci = await createWebhook(page, roomId, "Deploys", "sender");
    expect(ci.inbox).toBe(`${ci.url}/inbox-key`);
    const plain = await page.request.post(`${NODE}${pathOf(ci.url)}`, { data: { content: { type: "text", body: "plain" } } });
    expect(plain.status()).toBe(400);
    expect((await plain.json()).code).toBe("webhook.sealed_required");
    const embed = { title: "Build #7", description: "All **12** tests passed" };
    const sealed = await postSealed(page, ci.url, ci.inbox!, { content: { type: "text", body: "Deployed **v3**", embeds: [embed] }, username: "CI Bot" });
    expect(sealed.message.encrypted).toBe(true);
    expect(sealed.message.content.type).toBe("webhook.sealed");
    expect(JSON.stringify(sealed.message)).not.toContain("Deployed");
    expect(JSON.stringify(sealed.message)).not.toContain("CI Bot");

    // Node mode: the service posts plaintext over HTTPS, the node stores only the sealed box.
    const alerts = await createWebhook(page, roomId, "Alerts", "node");
    const posted = await page.request.post(`${NODE}${pathOf(alerts.url)}?wait=true`, { data: { content: { type: "text", body: "Disk full on db1" }, username: "Monitor" } });
    expect(posted.status(), await posted.text()).toBe(200);
    const nodeSealed = await posted.json();
    expect(nodeSealed.content.sealed_by).toBe("node");
    expect(JSON.stringify(nodeSealed)).not.toContain("Disk full");
    const stored = await (await page.request.get(`${NODE}/api/v1/conversations/${channelId}/messages`, { headers: auth })).text();
    expect(stored).not.toContain("Disk full");
    expect(stored).not.toContain("Deployed");

    // Members read both, with the WEBHOOK badge and a lock that says who sealed the message.
    await page.goto(roomUrl);
    const deployed = message(page, "Deployed v3");
    await expect(deployed).toBeVisible(CRYPTO);
    await expect(deployed.getByTestId("message-author")).toHaveText("CI Bot");
    await expect(deployed.getByTestId("webhook-badge")).toBeVisible();
    await expect(deployed.getByTestId("sealed-mark")).toHaveAttribute("data-sealed-by", "sender");
    await expect(deployed.getByTestId("message-embed-title")).toHaveText("Build #7");
    const disk = message(page, "Disk full on db1");
    await expect(disk).toBeVisible(CRYPTO);
    await expect(disk.getByTestId("message-author")).toHaveText("Monitor");
    await expect(disk.getByTestId("sealed-mark")).toHaveAttribute("title", "Vom Knoten versiegelt: Der Knoten hat den Text beim Posten gesehen.");
    await expect(page.getByTestId("undecryptable")).toHaveCount(0);

    // Bob joins later: the history keys of the older epoch let him read both sealed posts.
    await openRoomInvite(page);
    await page.getByRole("button", { name: "Link erzeugen" }).click();
    const link = await page.getByTestId("invite-link").inputValue();
    await page.getByRole("button", { name: "Fertig" }).click();
    await closeDrawers(page);
    const bobPage = await newPage(browser);
    await registerViaUi(bobPage, { prefix: "bob" });
    await bobPage.goto(link);
    await bobPage.getByRole("button", { name: "Beitreten" }).click();
    await expect(message(bobPage, "Deployed v3")).toBeVisible(CRYPTO);
    await expect(message(bobPage, "Disk full on db1").getByTestId("sealed-mark")).toBeVisible(CRYPTO);
    await expect(message(bobPage, "Deployed v3").getByTestId("webhook-badge")).toBeVisible();
    await expect(bobPage.getByTestId("undecryptable")).toHaveCount(0);

    // Bob's join was a commit: the inbox key of the new epoch is published, and a post sealed to it reaches both.
    await expect.poll(async () => (await (await page.request.get(`${NODE}${pathOf(ci.inbox!)}`)).json()).epoch, CRYPTO).toBeGreaterThan(sealed.epoch);
    const fresh = await postSealed(page, ci.url, ci.inbox!, { content: { type: "text", body: "Release v4 shipped" } });
    expect(fresh.epoch).toBeGreaterThan(sealed.epoch);
    await expect(message(bobPage, "Release v4 shipped")).toBeVisible(CRYPTO);
    await expect(message(page, "Release v4 shipped")).toBeVisible(CRYPTO);
    await expect(message(page, "Release v4 shipped").getByTestId("message-author")).toHaveText("Deploys");
    await bobPage.context().close();
  });
});
