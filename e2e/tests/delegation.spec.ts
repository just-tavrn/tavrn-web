// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ADULT_DOB, confirmRecoveryCodes, confirmRecoveryKey, logoutViaUi, openNavIfMobile, registerViaUi, tokenOf, uniqueName } from "./helpers";
import { A, B, BROWSER_API_A, FEDERATION_BROWSER, NODE_A, NODE_B, NODE_PORT_A, WEB_A, WEB_B, chromiumOnly } from "./federation-helpers";

test.use(FEDERATION_BROWSER);

// Identity domain vs. node host (design note 4.2c): a.test is the identity domain, but its node is served on
// another host (`TAVRN_PUBLIC_URL=http://127.0.0.1:<port>`, see playwright.config.ts). Clients and b.test
// resolve a.test through its well-known and talk to the delegated endpoint; addresses keep `@a.test` and
// passkeys keep the relying party id a.test.
const CRYPTO = { timeout: 20_000 };

/** A virtual authenticator whose credentials the test can read (relying party ids). */
async function authenticator(page: Page): Promise<() => Promise<Array<{ rpId?: string }>>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const options = { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
  let id: string;
  try {
    ({ authenticatorId: id } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { ...options, hasPrf: true } } as never));
  } catch {
    ({ authenticatorId: id } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options } as never));
  }
  return async () => ((await cdp.send("WebAuthn.getCredentials", { authenticatorId: id } as never)) as { credentials: Array<{ rpId?: string }> }).credentials;
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  return context.newPage();
}

function message(page: Page, text: string) {
  return page.getByTestId("message").filter({ hasText: text });
}

/** Phones: close an open navigation or member drawer before using the message area. */
async function closeDrawers(page: Page) {
  const overlay = page.getByRole("button", { name: "Drawer schließen" });
  if (!(await overlay.isVisible())) return;
  const members = (await page.getByTestId("members-drawer").getAttribute("data-open")) === "true";
  await overlay.click({ position: { x: members ? 8 : (page.viewportSize()?.width ?? 400) - 8, y: 300 } });
}

async function send(page: Page, text: string) {
  await closeDrawers(page);
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled(CRYPTO);
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(message(page, text)).toBeVisible();
}

async function api(page: Page, base: string, method: "get" | "post", path: string, data?: unknown) {
  const resp = await page.request[method](`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${await tokenOf(page)}` }, data });
  expect(resp.ok(), `${method} ${path}: ${resp.status()} ${await resp.text()}`).toBeTruthy();
  return resp.status() === 204 ? null : resp.json();
}

async function stored(page: Page) {
  return page.evaluate(() => ({ auth: JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}"), nodes: JSON.parse(localStorage.getItem("tavrn.nodes") ?? "{}") }));
}

test.describe("Identity domain and node host (delegation)", () => {
  chromiumOnly();

  test("The well-known of a.test delegates to another host", async ({ request }) => {
    const doc = await (await request.get(`${NODE_A}/.well-known/tavrn`)).json();
    expect(doc.domain).toBe(A);
    expect(doc.api).toBe(`${BROWSER_API_A}/api/v1`);
    expect(doc.ws).toBe(`ws://127.0.0.1:${NODE_PORT_A}/api/v1/ws`);
    expect(doc.web).toBe(WEB_A);
    // b.test resolves a.test through that document (its peer proxy serves browsers that cannot fetch it).
    const viaB = await (await request.get(`${NODE_B}/api/v1/federation/peer/${A}`)).json();
    expect(viaB.domain).toBe(A);
    expect(viaB.api).toBe(`${BROWSER_API_A}/api/v1`);
    // The resolution b.test hands to browsers (well-known → SRV → domain; the connect flow below uses it). The
    // SRV steps need a DNS server the harness does not have: Rust tests cover them with mock resolvers.
    const resolved = await (await request.get(`${NODE_B}/api/v1/federation/resolve/${A}`)).json();
    expect(resolved).toEqual({ domain: A, api: `${BROWSER_API_A}/api/v1`, ws: `ws://127.0.0.1:${NODE_PORT_A}/api/v1/ws`, web: WEB_A, source: "well_known" });
    const self = await request.get(`${NODE_B}/api/v1/federation/resolve/${B}`);
    expect(self.status()).toBe(400);
    expect((await self.json()).code).toBe("federation.target_self");
  });

  test("Connect flow with the identity domain, passkey with RP ID a.test", async ({ page }) => {
    test.setTimeout(150_000);
    const credentials = await authenticator(page);
    // An account on a.test with a passkey as its only factor, created in a.test's web client.
    const username = uniqueName("dpk");
    const password = `passwort-${username}-xyz`;
    await page.goto(`${WEB_A}/login`);
    await page.getByRole("tab", { name: "Registrieren" }).click();
    await page.getByLabel("Benutzername", { exact: true }).fill(username);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
    await page.getByLabel("Geburtsdatum", { exact: true }).fill(ADULT_DOB);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await page.getByTestId("choose-passkey").click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Schlüssel A");
    await page.getByRole("button", { name: "Passkey erstellen" }).click();
    await confirmRecoveryCodes(page);
    const words = await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    // The passkey is bound to the identity domain, not to the host that serves the API.
    expect((await credentials()).map((c) => c.rpId)).toEqual([A]);
    await openNavIfMobile(page);
    await logoutViaUi(page);
    await expect(page).toHaveURL(/\/login/);

    // On b.test: only the identity domain is typed; the well-known leads to the delegated endpoints.
    await page.goto(`${WEB_B}/login`);
    await page.getByTestId("remote-login-open").click();
    await page.getByLabel("Deine Adresse", { exact: true }).fill(A);
    await page.getByRole("button", { name: "Weiter", exact: true }).click();
    await expect(page.getByTestId("remote-home")).toHaveText(`Anmeldung bei ${A}`);
    await expect(page.getByTestId("remote-account")).toHaveText(A);
    await page.getByTestId("remote-connect").click();
    await expect(page).toHaveURL(new RegExp(`^${WEB_A}/login\\?next=`));
    await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
    const connectTitle = page.getByTestId("connect-title");
    const recoveryInput = page.getByTestId("recovery-key-input");
    await expect(connectTitle.or(recoveryInput)).toBeVisible();
    if (await recoveryInput.isVisible()) {
      await recoveryInput.fill(words);
      await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    }
    await expect(connectTitle).toHaveText("Bei einem anderen Web-Client anmelden?");
    await expect(page.getByTestId("connect-text")).toContainText(`${username}@${A}`);
    await page.getByTestId("connect-allow").click();

    await expect(page).toHaveURL(new RegExp(`^${WEB_B}/encryption`));
    await expect(page.getByTestId("encryption-account")).toHaveText(`${username}@${A}`);
    await page.getByTestId("recovery-key-input").fill(words);
    await page.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await openNavIfMobile(page);
    await expect(page.getByTestId("me-address")).toHaveText(`${username}@${A}`);

    // The session keeps the identity domain (addresses) and the delegated endpoints (requests).
    const { auth, nodes } = await stored(page);
    expect(auth.home).toMatchObject({ domain: A, base: BROWSER_API_A, ws: `ws://127.0.0.1:${NODE_PORT_A}/api/v1/ws`, web: WEB_A });
    expect(auth.user.address).toBe(`${username}@${A}`);
    expect(nodes[B].user.address).toBe(`${username}@${A}`);
  });

  test("Room and DM on the delegated node from b.test", async ({ browser, page }) => {
    test.setTimeout(300_000);
    const alice = await registerViaUi(page, { prefix: "dla", web: WEB_A, domain: A });
    const bobPage = await newPage(browser);
    const bob = await registerViaUi(bobPage, { prefix: "dlb", web: WEB_B, domain: B });

    // Alice creates an encrypted room on a.test and invites Bob (b.test) directly by address.
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Raum erstellen" }).click();
    const roomName = `Delegiert ${alice.username.slice(-5)}`;
    await page.getByRole("dialog").getByLabel("Name").fill(roomName);
    await page.getByRole("dialog").getByRole("button", { name: "Erstellen" }).click();
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    const channelId = page.url().split("/channels/")[1]!;
    await openNavIfMobile(page);
    await page.getByRole("button", { name: "Einladen" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Eine Person direkt einladen").fill(bob.address);
    await dialog.getByRole("button", { name: "Einladung senden" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Einladung an ${bob.address} gesendet` })).toBeVisible();
    await dialog.getByRole("button", { name: "Abbrechen" }).click();

    // Bob accepts on b.test: his client resolves a.test and joins through the delegated endpoint.
    const invite = bobPage.getByTestId("invite-list").getByTestId("invite").filter({ hasText: roomName });
    await expect(invite).toContainText(`Von ${alice.address} · auf ${A}`, CRYPTO);
    await invite.getByRole("button", { name: "Annehmen" }).click();
    await expect(bobPage).toHaveURL(new RegExp(`/n/${A}/rooms/[0-9A-Z]+/channels/${channelId}`), CRYPTO);
    await openNavIfMobile(bobPage);
    await expect(bobPage.getByTestId("room-node")).toHaveText(A);
    await closeDrawers(bobPage);
    const session = (await stored(bobPage)).nodes[A];
    expect(session).toMatchObject({ domain: A, base: BROWSER_API_A, ws: `ws://127.0.0.1:${NODE_PORT_A}/api/v1/ws` });
    expect(session.user.address).toBe(bob.address);
    // Addresses show the identity domain, whatever host serves the node.
    await expect(bobPage.locator(`[data-testid="member-row"][data-address="${alice.address}"]`)).toHaveCount(1, CRYPTO);
    await expect(bobPage.locator(`[data-testid="member-row"][data-address="${bob.address}"]`)).toHaveCount(1);

    await send(bobPage, "Hallo aus b.test");
    await expect(message(page, "Hallo aus b.test")).toBeVisible(CRYPTO);
    await send(page, "Hallo aus a.test");
    await expect(message(bobPage, "Hallo aus a.test")).toBeVisible(CRYPTO);

    // Friends across the nodes, then a DM that lives on a.test (the initiator's home node).
    await api(page, NODE_A, "post", "/users/me/friends/requests", { user: bob.address });
    await expect.poll(async () => (await api(bobPage, NODE_B, "get", "/users/me/friends")).incoming.length, CRYPTO).toBeGreaterThan(0);
    await bobPage.goto(`${WEB_B}/friends`);
    await expect(bobPage.getByTestId("friends-incoming")).toContainText(alice.address);
    await bobPage.getByTestId("friends-incoming").getByRole("button", { name: "Annehmen" }).click();
    await expect(bobPage.getByTestId("friends-list")).toContainText(alice.address);
    await page.goto(`${WEB_A}/friends`);
    await expect(page.getByTestId("friends-list")).toContainText(bob.address, CRYPTO);
    await page.getByTestId("friends-list").locator("li").filter({ hasText: bob.address }).getByRole("button", { name: "Nachricht" }).click();
    await expect(page.getByTestId("conversation-name")).toHaveText(bob.username);
    await send(page, "DM über den delegierten Host");

    await bobPage.goto(`${WEB_B}/`);
    await openNavIfMobile(bobPage);
    const dm = bobPage.getByTestId("dm-list").getByRole("link", { name: new RegExp(alice.username) });
    await expect(dm).toBeVisible(CRYPTO);
    await expect(dm.getByTestId("conversation-node")).toHaveText(A);
    await dm.click();
    await expect(bobPage).toHaveURL(new RegExp(`/n/${A}/conversations/`));
    await expect(message(bobPage, "DM über den delegierten Host")).toBeVisible(CRYPTO);
    await send(bobPage, "Angekommen");
    await expect(message(page, "Angekommen")).toBeVisible(CRYPTO);
    await bobPage.context().close();
  });
});
