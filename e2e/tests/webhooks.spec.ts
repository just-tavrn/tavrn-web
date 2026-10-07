// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, registerViaApi } from "./helpers";

// Incoming webhooks, phase 5 step 4 (tavrn-protocol/APPLICATIONS.md §6.1, §6.4): created in the room settings with the URL
// shown once, executed like a CI service would (a plain HTTP POST), shown with the WEBHOOK badge and its embed.

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The path of an execution URL (the URL names the node's public origin; the test talks to the node directly). */
const pathOf = (url: string) => url.slice(url.indexOf("/api/v1/"));

test.describe("Webhooks (APPLICATIONS.md §6)", () => {
  test("create a webhook, see its URL once, post with fetch, see the badge and the embed", async ({ page, request, context, browserName }) => {
    const owner = await registerViaApi(request, "hook");
    const room = await createRoomViaApi(request, owner.token, "Webhook-Raum");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await loginAs(page, owner);
    await page.goto(`/rooms/${room.id}/settings/webhooks`);
    await expect(page.getByTestId("webhooks-tab")).toBeVisible();
    await page.getByTestId("webhook-name").fill("Deploys");
    await expect(page.getByTestId("webhook-channel")).toHaveValue(channel.id);
    await page.getByTestId("webhook-create").click();

    // The URL with its secret is shown exactly once.
    const field = page.getByTestId("webhook-url");
    await expect(field).toBeVisible();
    const url = await field.inputValue();
    expect(url).toMatch(/\/api\/v1\/webhooks\/[0-9A-Z]{26}\/[A-Za-z0-9_-]{43}$/);
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.getByTestId("webhook-url-copy").click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
    }
    await page.getByTestId("webhook-url-done").click();
    await expect(page.getByTestId("webhook-url")).toHaveCount(0);
    const row = page.getByTestId("webhook-row");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("webhook-badge")).toBeVisible();
    expect(await page.content()).not.toContain(url.split("/").pop()!);

    // A service posts (no authentication, just the URL), with an embed and its own name.
    const embed = {
      title: "Build #128",
      description: "All **42** tests passed",
      url: "https://ci.example/b/128",
      color: 3066993,
      fields: [
        { name: "Branch", value: "main", inline: true },
        { name: "Duration", value: "3 min", inline: true },
      ],
      footer: "ci.example",
      timestamp: "2026-10-05T12:00:00Z",
    };
    const posted = await page.request.post(`${NODE}${pathOf(url)}?wait=true`, { data: { content: { type: "text", body: "Deployed **v1.2**", embeds: [embed] }, username: "CI Bot" } });
    expect(posted.status(), await posted.text()).toBe(200);
    const message = await posted.json();
    expect(message.author_kind).toBe("webhook");
    expect(message.webhook.name).toBe("CI Bot");
    expect(message.device_id).toBeNull();

    await page.goto(`/rooms/${room.id}`);
    const shown = page.getByTestId("message").filter({ hasText: "Deployed" });
    await expect(shown).toBeVisible();
    await expect(shown.getByTestId("message-author")).toHaveText("CI Bot");
    await expect(shown.getByTestId("webhook-badge")).toBeVisible();
    await expect(shown.getByTestId("bot-badge")).toHaveCount(0);
    await expect(shown.getByTestId("unverified-marker")).toHaveCount(0);
    const card = shown.getByTestId("message-embed");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-color", "#2ecc71");
    await expect(card.getByTestId("message-embed-title")).toHaveText("Build #128");
    await expect(card.getByTestId("message-embed-host")).toHaveText("ci.example");
    await expect(card.getByTestId("message-embed-description").locator("strong")).toHaveText("42");
    await expect(card.getByTestId("message-embed-field")).toHaveCount(2);
    await expect(card.getByTestId("message-embed-footer")).toContainText("ci.example");
    await expect(card.locator("img")).toHaveCount(0);
    // The card fits the viewport (phones included).
    const box = await card.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

    // Wrong secrets and unknown ids look the same.
    const wrong = await page.request.post(`${NODE}${pathOf(url).replace(/[^/]+$/, "A".repeat(43))}`, { data: { content: { type: "text", body: "x" } } });
    expect(wrong.status()).toBe(404);
    expect((await wrong.json()).code).toBe("webhook.not_found");

    // Encrypting the channel keeps the webhook, now sealed by the service (APPLICATIONS.md §6.1a): plaintext is refused
    // and the settings show the mode and the wait for a member's inbox key (nobody has opened the encrypted channel).
    await page.goto(`/rooms/${room.id}/settings/webhooks`);
    const encrypt = await request.patch(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}`, { headers: auth(owner.token), data: { encrypted: true } });
    expect(encrypt.status()).toBe(200);
    const refused = await page.request.post(`${NODE}${pathOf(url)}`, { data: { content: { type: "text", body: "x" } } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("webhook.pending_key");
    await page.reload();
    await expect(page.getByTestId("webhook-mode")).toContainText("vom Dienst versiegelt");
    await expect(page.getByTestId("webhook-pending")).toBeVisible();
    const decrypt = await request.patch(`${NODE}/api/v1/rooms/${room.id}/channels/${channel.id}`, { headers: auth(owner.token), data: { encrypted: false } });
    expect(decrypt.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId("webhook-row")).toBeVisible();
    await expect(page.getByTestId("webhook-mode")).toHaveCount(0);
    await expect(page.getByTestId("webhook-pending")).toHaveCount(0);

    // Rename and reset: the old URL stops working, the new one is shown once.
    await page.getByTestId("webhook-edit").click();
    await page.getByTestId("webhook-rename").fill("Releases");
    await page.getByTestId("webhook-save").click();
    await expect(page.getByTestId("webhook-row-name")).toHaveText("Releases");
    await page.getByTestId("webhook-reset").click();
    await page.getByRole("dialog").getByRole("button").last().click();
    const fresh = await page.getByTestId("webhook-url").inputValue();
    expect(fresh).not.toBe(url);
    await page.getByTestId("webhook-url-done").click();
    expect((await page.request.post(`${NODE}${pathOf(url)}`, { data: { content: { type: "text", body: "old" } } })).status()).toBe(404);
    expect((await page.request.post(`${NODE}${pathOf(fresh)}`, { data: { content: { type: "text", body: "new" } } })).status()).toBe(204);

    // Delete: gone from the list, the URL is dead, its messages stay.
    await page.getByTestId("webhook-delete").click();
    await page.getByRole("dialog").getByRole("button").last().click();
    await expect(page.getByTestId("webhook-row")).toHaveCount(0);
    expect((await page.request.post(`${NODE}${pathOf(fresh)}`, { data: { content: { type: "text", body: "gone" } } })).status()).toBe(404);
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("message").filter({ hasText: "Deployed" }).getByTestId("webhook-badge")).toBeVisible();
  });

  test("members without manage_webhooks do not see the tab", async ({ page, request }) => {
    const owner = await registerViaApi(request, "hookown");
    const member = await registerViaApi(request, "hookmem");
    const room = await createRoomViaApi(request, owner.token, "Ohne Webhooks");
    const invite = await request.post(`${NODE}/api/v1/rooms/${room.id}/invites`, { headers: auth(owner.token), data: {} });
    const code = (await invite.json()).code as string;
    expect((await request.post(`${NODE}/api/v1/invites/${code}/join`, { headers: auth(member.token), data: {} })).status()).toBe(200);
    await loginAs(page, member);
    await page.goto(`/rooms/${room.id}/settings/webhooks`);
    // The page falls back to the overview; the tab is not offered.
    await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}/settings/overview`));
    await expect(page.getByRole("link", { name: /^Webhooks$/ })).toHaveCount(0);
  });
});
