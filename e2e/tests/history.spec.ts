// SPDX-License-Identifier: Apache-2.0
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, inviteCode, loginAs, openNavIfMobile, registerViaApi } from "./helpers";
import { scaled } from "./timeouts";

// Lazy history and unread counts (design note 4.4): badges from the node's counts, live updates, read
// markers, and paging older messages in.

async function api(request: APIRequestContext, method: "post" | "put", path: string, token: string, data: unknown) {
  const resp = await request[method](`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` }, data });
  if (!resp.ok()) throw new Error(`${method} ${path}: ${resp.status()} ${await resp.text()}`);
  return resp.json();
}

async function say(request: APIRequestContext, token: string, roomId: string, channelId: string, body: string, extra: Record<string, unknown> = {}) {
  return api(request, "post", `/rooms/${roomId}/channels/${channelId}/messages`, token, { content: { type: "text", body }, ...extra });
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

test.describe("History and unread", () => {
  test("Unread counters and mentions appear live and disappear on opening", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Zählraum");
    const general = room.channels.find((c: { kind: string }) => c.kind === "text");
    const news = await api(request, "post", `/rooms/${room.id}/channels`, alice.token, { kind: "text", name: "neuigkeiten", encrypted: false });
    await api(request, "post", `/invites/${await inviteCode(request, alice.token, room.id)}/join`, bob.token, {});

    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}/channels/${general.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await expect(page.getByTestId("ws-status")).toHaveAttribute("data-status", "ready");
    await openNavIfMobile(page);
    const link = page.getByRole("link", { name: /neuigkeiten/ });
    await expect(link.getByTestId("unread-count")).toHaveCount(0);

    await say(request, alice.token, room.id, news.id, "Erste Neuigkeit");
    await expect(link.getByTestId("unread-count")).toHaveText("1");
    await expect(link).toHaveAttribute("data-unread", "true");
    await expect(link.getByTestId("mention-count")).toHaveCount(0);
    await say(request, alice.token, room.id, news.id, `@${bob.username} schau mal`, { mentions: [`${bob.username}@localhost`] });
    await expect(link.getByTestId("unread-count")).toHaveText("2");
    await expect(link.getByTestId("mention-count")).toHaveText("@1");

    // The counts come from the node: still there after a reload.
    await page.reload();
    await openNavIfMobile(page);
    await expect(link.getByTestId("unread-count")).toHaveText("2");
    await expect(link.getByTestId("mention-count")).toHaveText("@1");

    await link.click();
    await expect(page.getByTestId("channel-name")).toHaveText("neuigkeiten");
    await expect(message(page, "schau mal")).toBeVisible();
    await openNavIfMobile(page);
    await expect(link.getByTestId("unread-count")).toHaveCount(0);
    await expect(link.getByTestId("mention-count")).toHaveCount(0);
    // The read marker reached the node.
    await expect
      .poll(async () => {
        const resp = await request.get(`${NODE}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${bob.token}` } });
        return (await resp.json()).read_states.find((s: { conversation_id: string }) => s.conversation_id === news.id)?.unread_count;
      })
      .toBe(0);
    await page.reload();
    await openNavIfMobile(page);
    await expect(page.getByRole("link", { name: /neuigkeiten/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /neuigkeiten/ }).getByTestId("unread-count")).toHaveCount(0);
  });

  test("load older messages without the view jumping", async ({ page, request }) => {
    test.setTimeout(scaled(120_000));
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const room = await createRoomViaApi(request, alice.token, "Archiv");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    await api(request, "post", `/invites/${await inviteCode(request, alice.token, room.id)}/join`, bob.token, {});
    for (let i = 1; i <= 120; i++) await say(request, alice.token, room.id, channel.id, `Verlauf ${String(i).padStart(3, "0")}`);

    await loginAs(page, bob);
    await page.goto(`/rooms/${room.id}/channels/${channel.id}`);
    // Only the newest page (50) is loaded on open; the list keeps only the rows near the view in the DOM.
    const list = page.getByTestId("message-list");
    await expect(message(page, "Verlauf 120")).toBeVisible();
    await expect(list).toHaveAttribute("data-loaded", "50");
    await expect(message(page, "Verlauf 070")).toHaveCount(0);
    expect(await page.getByTestId("message").count()).toBeLessThan(50);

    // The button at the top (reaching it also starts the automatic loading; one request either way).
    const older = page.getByRole("button", { name: "Ältere Nachrichten laden" });
    await older.click();
    await expect(list).toHaveAttribute("data-loaded", "100");
    // The view stays where it was: the previously oldest message is still on screen.
    await expect(message(page, "Verlauf 071")).toBeInViewport();
    await expect(message(page, "Verlauf 120")).not.toBeInViewport();
    // Scrolling up to the top loads the rest (button or automatic loading).
    await list.evaluate((el) => el.scrollTo({ top: 0 }));
    // 120 messages and the notice that the channel is not encrypted.
    await expect(list).toHaveAttribute("data-loaded", "121");
    await expect(older).toHaveCount(0);
    await list.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(message(page, "Verlauf 001")).toBeVisible();
    await expect(page.getByTestId("history-start")).toBeVisible();

    // New messages of others while scrolled up: "jump to latest".
    await say(request, alice.token, room.id, channel.id, "Ganz neu");
    await expect(list).toHaveAttribute("data-loaded", "122");
    await page.getByTestId("jump-latest").click();
    await expect(message(page, "Ganz neu")).toBeInViewport();
  });
});
