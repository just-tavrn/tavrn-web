// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";
import { NODE, loginAs, openNavIfMobile, registerViaApi } from "./helpers";

test.describe("Friends", () => {
  test("Send and withdraw a request, decline an incoming one, block and unblock", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    const bob = await registerViaApi(request, "bob");
    const carol = await registerViaApi(request, "carol");
    await loginAs(page, alice);
    await page.goto("/");
    await openNavIfMobile(page);
    await page.getByRole("link", { name: "Freunde" }).click();
    await expect(page.getByRole("heading", { name: "Freunde", level: 1 })).toBeVisible();

    // Outgoing request with the full address, then withdrawn.
    await page.getByLabel("Benutzername oder Adresse").fill(`${bob.username}@localhost`);
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    const outgoing = page.getByTestId("friends-outgoing");
    await expect(outgoing).toContainText(`${bob.username}@localhost`);
    await outgoing.getByRole("button", { name: "Zurückziehen" }).click();
    await expect(outgoing).not.toContainText(bob.username);
    await page.getByLabel("Benutzername oder Adresse").fill("gibt-es-nicht");
    await page.getByRole("button", { name: "Anfrage senden" }).click();
    await expect(page.getByRole("alert")).toBeVisible();

    // Incoming request arrives live (toast + list) and is declined.
    const resp = await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${carol.token}` }, data: { user: alice.username } });
    expect(resp.status()).toBe(201);
    await expect(page.getByRole("status").filter({ hasText: "Neue Freundschaftsanfrage" })).toBeVisible();
    const incoming = page.getByTestId("friends-incoming");
    await expect(incoming).toContainText(`${carol.username}@localhost`);
    await incoming.getByRole("button", { name: "Ablehnen" }).click();
    await expect(incoming).not.toContainText(carol.username);

    // Block from an incoming request; blocked users cannot ask again; unblock.
    await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${bob.token}` }, data: { user: alice.username } });
    await expect(incoming).toContainText(bob.username);
    await incoming.getByRole("button", { name: "Blockieren" }).click();
    // Blocking asks for an optional private note (design note 4.9), shown only in the own block list.
    await page.getByRole("dialog").getByLabel("Private Notiz (optional)").fill("Spam-Anfragen");
    await page.getByTestId("block-confirm").click();
    const blocked = page.getByTestId("friends-blocked");
    await expect(blocked).toContainText(`${bob.username}@localhost`);
    await expect(blocked.getByTestId("blocked-reason")).toContainText("Spam-Anfragen");
    const again = await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${bob.token}` }, data: { user: alice.username } });
    expect(again.status()).toBe(403);
    await blocked.getByRole("button", { name: "Blockierung aufheben" }).click();
    await expect(blocked).not.toContainText(bob.username);

    // Accepted friendship, then removed.
    await request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${carol.token}` }, data: { user: alice.username } });
    await incoming.getByRole("button", { name: "Annehmen" }).click();
    const friends = page.getByTestId("friends-list");
    await expect(friends).toContainText(`${carol.username}@localhost`);
    page.once("dialog", (d) => d.accept());
    await friends.getByRole("button", { name: "Entfernen" }).click();
    await expect(friends).not.toContainText(carol.username);
  });
});
