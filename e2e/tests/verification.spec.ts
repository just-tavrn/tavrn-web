// SPDX-License-Identifier: Apache-2.0
// Identity verification (FEDERATION.md §10): safety numbers, verified contacts, the block after a key
// change in DMs, and device signatures on plaintext messages.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { NODE, confirmRecoveryKey, createRoomViaApi, inviteCode, loginViaUi, openNavIfMobile, registerViaApi, registerViaUi, tokenOf, type UiAccount } from "./helpers";

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: 20_000 });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

async function befriend(a: Page, b: Page, bUser: UiAccount) {
  const resp = await a.request.post(`${NODE}/api/v1/users/me/friends/requests`, { headers: { Authorization: `Bearer ${await tokenOf(a)}` }, data: { user: bUser.username } });
  expect(resp.ok()).toBeTruthy();
  const token = await tokenOf(b);
  const list = await (await b.request.get(`${NODE}/api/v1/users/me/friends`, { headers: { Authorization: `Bearer ${token}` } })).json();
  for (const r of list.incoming) await b.request.post(`${NODE}/api/v1/users/me/friends/requests/${r.id}/accept`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Opens the verification dialog for `address` from the friends page. */
async function openVerify(page: Page, address: string) {
  await page.goto("/friends");
  await page.getByTestId("friends-list").locator("li").filter({ hasText: address }).getByTestId("verify-button").click();
  const dialog = page.getByTestId("verify-dialog");
  await expect(dialog.getByTestId("safety-number")).toBeVisible();
  return dialog;
}

test.describe("Identity verification", () => {
  test("Compare safety numbers, verify; after a key change the DM is locked until the new key is accepted", async ({ browser, page }) => {
    test.setTimeout(240_000);
    const alice = await registerViaUi(page, { prefix: "alice" });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "bob" });
    await befriend(page, bobPage, bob);

    // Both see the same 12 groups of 5 digits and the same code.
    const aliceDialog = await openVerify(page, bob.address);
    await expect(aliceDialog.getByTestId("verify-address")).toHaveText(bob.address);
    await expect(aliceDialog.getByTestId("verify-qr")).toBeVisible();
    const aliceNumber = (await aliceDialog.getByTestId("safety-number").locator("span").allTextContents()).join(" ");
    expect(aliceNumber).toMatch(/^(\d{5} ){11}\d{5}$/);
    const bobDialog = await openVerify(bobPage, alice.address);
    expect((await bobDialog.getByTestId("safety-number").locator("span").allTextContents()).join(" ")).toBe(aliceNumber);
    const bobCode = await bobDialog.getByTestId("verify-payload").inputValue();
    expect(bobCode).toMatch(/^tavrn:verify\?v=1&a=/);
    expect(await aliceDialog.getByTestId("verify-payload").inputValue()).toBe(bobCode);

    // A wrong code does not match; Bob's code (as scanned or pasted) does.
    const field = aliceDialog.getByLabel("Gescannter oder eingefügter Code der anderen Person");
    await field.fill(bobCode.replace("v=1", "v=2"));
    await aliceDialog.getByRole("button", { name: "Vergleichen" }).click();
    await expect(aliceDialog.getByTestId("verify-result")).toHaveAttribute("data-result", "mismatch");
    await expect(aliceDialog.getByRole("button", { name: "Als verifiziert markieren" })).toBeDisabled();
    await field.fill(bobCode);
    await aliceDialog.getByRole("button", { name: "Vergleichen" }).click();
    await expect(aliceDialog.getByTestId("verify-result")).toHaveText("✓ Die Codes stimmen überein.");    await aliceDialog.getByRole("button", { name: "Als verifiziert markieren" }).click();
    await expect(aliceDialog.getByTestId("verify-state")).toHaveAttribute("data-state", "verified");
    await aliceDialog.getByRole("button", { name: "Schließen", exact: true }).click();
    await expect(page.getByTestId("friends-list").getByTestId("verified-badge")).toBeVisible();
    await bobDialog.getByRole("button", { name: "Schließen", exact: true }).click();

    // DM between the two; the verified badge is shown in the header.
    await page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText(bob.username);
    await expect(page.getByTestId("verified-badge").first()).toBeVisible();
    await send(page, "Vor dem Schlüsselwechsel");
    await expect(message(page, "Vor dem Schlüsselwechsel")).toBeVisible();

    // Bob loses his recovery key and resets his identity on a new device.
    const bob2 = await newPage(browser);
    await loginViaUi(bob2, bob);
    await bob2.getByRole("button", { name: /Identität zurücksetzen/ }).click();
    await bob2.getByLabel("Passwort", { exact: true }).fill(bob.password);
    await bob2.getByRole("button", { name: "Weiter", exact: true }).click();
    await confirmRecoveryKey(bob2, "Identität zurücksetzen");
    await expect(bob2.getByTestId("app-shell")).toBeVisible();

    // Alice's DM with the verified contact is blocked until she decides.
    const notice = page.getByTestId("verification-notice");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toHaveAttribute("data-blocking", "true");
    await expect(notice).toContainText(`${bob.address} hat einen neuen Sicherheitsschlüssel`);
    await expect(page.getByLabel("Nachricht", { exact: true })).toBeDisabled();
    await expect(page.getByTestId("verification-broken-badge").first()).toBeVisible();
    await notice.getByRole("button", { name: "Ich vertraue dem neuen Schlüssel" }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId("verified-badge")).toHaveCount(0);
    await send(page, "Nach dem Schlüsselwechsel");
    await expect(message(page, "Nach dem Schlüsselwechsel")).toBeVisible();
    // Bob's new device reads it.
    await bob2.goto("/");
    await openNavIfMobile(bob2);
    await bob2.getByTestId("dm-list").getByRole("link", { name: new RegExp(alice.username) }).click();
    await expect(message(bob2, "Nach dem Schlüsselwechsel")).toBeVisible({ timeout: 20_000 });
    await bobPage.context().close();
    await bob2.context().close();
  });

  test("Plaintext messages: signed by the device, marked as unverified without a signature (API account)", async ({ page, request }) => {
    test.setTimeout(120_000);
    // An API-only account has no device key: its messages are unsigned.
    const owner = await registerViaApi(request, "apiown");
    const room = await createRoomViaApi(request, owner.token, "Offener Raum");
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;
    const posted = await request.post(`${NODE}/api/v1/conversations/${channel}/messages`, { headers: { Authorization: `Bearer ${owner.token}` }, data: { content: { type: "text", body: "Von der API" } } });
    expect(posted.status()).toBe(201);
    const code = await inviteCode(request, owner.token, room.id);

    await registerViaUi(page, { prefix: "carol" });
    await page.goto(`/invite/${code}`);
    await page.getByRole("button", { name: "Beitreten" }).click();
    await expect(page.getByTestId("unencrypted-banner")).toBeVisible();
    const unsigned = message(page, "Von der API");
    await expect(unsigned.getByTestId("unverified-marker")).toBeVisible();
    await expect(unsigned.getByTestId("unverified-marker")).toHaveAttribute("title", /Nicht vom Gerät des Absenders signiert/);

    // The browser signs what it sends: no marker, and the node stores the signature.
    await send(page, "Signiert vom Browser");
    const own = message(page, "Signiert vom Browser");
    await expect(own).toBeVisible();
    await page.reload();
    await expect(message(page, "Signiert vom Browser")).toBeVisible();
    await expect(message(page, "Von der API").getByTestId("unverified-marker")).toBeVisible();
    await expect(message(page, "Signiert vom Browser").getByTestId("unverified-marker")).toHaveCount(0);
    const list = await (await request.get(`${NODE}/api/v1/conversations/${channel}/messages`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
    const stored = list.find((m: { content: { body?: string } }) => m.content?.body === "Signiert vom Browser");
    expect(stored.signature).toMatch(/^[A-Za-z0-9_-]{107}$/);
    expect(list.find((m: { content: { body?: string } }) => m.content?.body === "Von der API").signature).toBeNull();
  });
});
