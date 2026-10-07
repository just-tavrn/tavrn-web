// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { createRoomViaApi, registerViaApi } from "./helpers";
import { A, FEDERATION_BROWSER, NODE_A, NODE_B, NODE_PORT_B, WEB_A, chromiumOnly, federatedSession, loginOn } from "./federation-helpers";

test.use(FEDERATION_BROWSER);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// Custom emojis across nodes (design note 4.13): a personal emoji of b.test used in a room on a.test is shown to a
// reader on a.test from a.test's cached copy (the browser never contacts b.test), stays visible after b.test
// deleted it, and an emoji that exists nowhere becomes a muted placeholder.
test.describe("Emojis across nodes", () => {
  chromiumOnly();

  test("personal emoji from b.test in a room on a.test", async ({ page, request }) => {
    const bob = await registerViaApi(request, "emob", NODE_B);
    const carol = await registerViaApi(request, "emoc", NODE_A);
    const up = await request.post(`${NODE_B}/api/v1/users/me/emojis`, { headers: { Authorization: `Bearer ${bob.token}`, "Content-Type": "image/png", "Tavrn-Emoji-Name": "winke" }, data: PNG });
    expect(up.status(), await up.text()).toBe(201);
    const emojiId = (await up.json()).id as string;

    const room = await createRoomViaApi(request, carol.token, "Emoji-Raum", "public", { base: NODE_A });
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const onA = await federatedSession(request, NODE_B, bob.token, A, NODE_A);
    expect((await request.post(`${NODE_A}/api/v1/rooms/${room.id}/join`, { headers: { Authorization: `Bearer ${onA}` }, data: {} })).ok()).toBe(true);
    const messages = `${NODE_A}/api/v1/rooms/${room.id}/channels/${channel.id}/messages`;
    const post = await request.post(messages, { headers: { Authorization: `Bearer ${onA}` }, data: { content: { type: "text", body: `hallo <:winke:${emojiId}@b.test> und <:weg:01J9ZK8Q4V6X3M2N1P0R5S7T8W@b.test>` } } });
    expect(post.status(), await post.text()).toBe(201);

    const toB: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.hostname === "b.test" || u.port === NODE_PORT_B) toB.push(r.url());
    });
    await loginOn(page, WEB_A, carol, { domain: A, remote: false });
    await page.goto(`${WEB_A}/rooms/${room.id}`);
    const message = page.getByTestId("message").filter({ hasText: "hallo" });
    const img = message.locator("img.emoji[alt=':winke:']");
    await expect(img).toBeVisible();
    expect(await img.getAttribute("src")).toContain(`/api/v1/emojis/${emojiId}/image?host=b.test`);
    await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // Unknown everywhere: a placeholder chip with the name.
    const missing = message.getByTestId("emoji-missing");
    await expect(missing).toHaveText(":weg:");
    await expect(missing).toHaveAttribute("title", "Emoji nicht mehr verfügbar");

    // b.test deletes it: a.test keeps serving its copy.
    expect((await request.delete(`${NODE_B}/api/v1/users/me/emojis/${emojiId}`, { headers: { Authorization: `Bearer ${bob.token}` } })).status()).toBe(204);
    await page.reload();
    const again = page.getByTestId("message").filter({ hasText: "hallo" }).locator("img.emoji[alt=':winke:']");
    await expect.poll(() => again.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(toB).toEqual([]);
  });
});
