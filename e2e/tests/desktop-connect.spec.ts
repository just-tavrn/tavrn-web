// SPDX-License-Identifier: Apache-2.0
/**
 * The node's `/connect` page in session mode (FEDERATION.md §8 step 3): what the desktop app's sign-in window shows.
 * The app's side (an app session with a PKCE verifier, the polls, the exchange) runs over the API here, the page in
 * the browser, with every way to sign in there: password and TOTP, registration with a passkey, a passkey-only
 * sign-in, single sign-on. The page never runs the encryption step (device keys are made in the app).
 */
import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, addVirtualAuthenticator, confirmRecoveryCodes, nextTotpCode, registerViaApi, uniqueName } from "./helpers";

interface AppSession {
  id: string;
  verifier: string;
  url: string;
}

/** What the app does first: a PKCE pair and an app session with its device name. */
async function createAppSession(request: APIRequestContext, deviceName: string, mode?: "register"): Promise<AppSession> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const resp = await request.post(`${NODE}/api/v1/auth/connect/session`, { data: { code_challenge: challenge, device_name: deviceName } });
  expect(resp.status(), await resp.text()).toBe(200);
  const { session_id: id, expires_in } = await resp.json();
  expect(expires_in).toBe(600);
  const state = randomBytes(16).toString("base64url");
  return { id, verifier, url: `/connect?session=${id}&state=${state}${mode ? `&mode=${mode}` : ""}` };
}

/** The app's polls: the code once, then the session is gone; the exchange gives the app its own device. */
async function appCompletes(request: APIRequestContext, s: AppSession, address: string, deviceName: string) {
  let ready: { status: string; code?: string; node?: string } = { status: "pending" };
  await expect
    .poll(async () => {
      ready = await (await request.get(`${NODE}/api/v1/auth/connect/session/${s.id}`)).json();
      return ready.status;
    })
    .toBe("ready");
  expect(ready.node).toBe("localhost");
  expect((await request.get(`${NODE}/api/v1/auth/connect/session/${s.id}`)).status()).toBe(410);
  const exchange = await request.post(`${NODE}/api/v1/auth/connect/token`, { data: { code: ready.code, code_verifier: s.verifier } });
  expect(exchange.status(), await exchange.text()).toBe(200);
  const session = await exchange.json();
  expect(session.user.address).toBe(address);
  const devices = await (await request.get(`${NODE}/api/v1/users/me/devices`, { headers: { Authorization: `Bearer ${session.access_token}` } })).json();
  expect(devices.find((d: { id: string }) => d.id === session.device_id)?.name).toBe(deviceName);
}

/** The confirmation on the page: the app's device name, the warning, then "return to the app". */
async function confirmOnPage(page: Page, address: string, deviceName: string) {
  await expect(page.getByTestId("connect-title")).toHaveText("Bei der Tavrn-App anmelden?", { timeout: 20_000 });
  await expect(page.getByTestId("connect-text")).toContainText(deviceName);
  await expect(page.getByTestId("connect-text")).toContainText(address);
  await expect(page.getByTestId("connect-warning")).toBeVisible();
  await expect(page.getByTestId("encryption-title")).toHaveCount(0);
  // The page fits the phone width without horizontal scrolling.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId("connect-allow").click();
  await expect(page.getByTestId("connect-done")).toHaveText("Du bist angemeldet. Kehre zur Tavrn-App zurück.");
}

test.describe("Sign-in page of the desktop app (app sessions, FEDERATION.md §8 step 3)", () => {
  test("password and TOTP on the node's page; the app polls the code and gets its own device", async ({ page, request }) => {
    const account = await registerViaApi(request, "dc");
    const device = "Tavrn-Desktop (Test)";
    const s = await createAppSession(request, device);
    await page.goto(s.url);
    await page.getByLabel("Benutzername", { exact: true }).fill(account.username);
    await page.getByLabel("Passwort", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(account));
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await confirmOnPage(page, `${account.username}@localhost`, device);
    await appCompletes(request, s, `${account.username}@localhost`, device);
  });

  test("registration with a passkey, then a passkey-only sign-in on the node's page", async ({ page, request, browserName }) => {
    test.skip(browserName !== "chromium", "CDP virtual authenticator is Chromium only");
    test.setTimeout(120_000);
    await addVirtualAuthenticator(page);
    const username = uniqueName("dcpk");
    const password = `passwort-${username}-xyz`;
    const first = await createAppSession(request, "Desktop app", "register");
    await page.goto(first.url);
    await expect(page.getByRole("tab", { name: "Registrieren" })).toHaveAttribute("aria-selected", "true");
    await page.getByLabel("Benutzername", { exact: true }).fill(username);
    await page.getByLabel("Passwort", { exact: true }).fill(password);
    await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await page.getByTestId("choose-passkey").click();
    await page.getByLabel("Name des Passkeys", { exact: true }).fill("Virtueller Schlüssel");
    await page.getByRole("button", { name: "Passkey erstellen" }).click();
    await confirmRecoveryCodes(page);
    // No recovery key on the page: the app sets up encryption after the exchange.
    await confirmOnPage(page, `${username}@localhost`, "Desktop app");
    await appCompletes(request, first, `${username}@localhost`, "Desktop app");

    // The next sign-in of the app: signed out on the page, the passkey alone.
    await page.evaluate(() => localStorage.removeItem("tavrn.auth"));
    const second = await createAppSession(request, "Desktop app");
    await page.goto(second.url);
    await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
    await confirmOnPage(page, `${username}@localhost`, "Desktop app");
    await appCompletes(request, second, `${username}@localhost`, "Desktop app");
  });

  test("single sign-on on the node's page", async ({ page, request }) => {
    const username = uniqueName("dcsso");
    const s = await createAppSession(request, "Desktop app");
    await page.goto(s.url);
    await page.getByTestId("sso-button").click();
    await expect(page.getByRole("heading", { name: "Fake IdP sign-in" })).toBeVisible();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Display name").fill(`${username} (IdP)`);
    await page.getByRole("button", { name: "Sign in at the IdP" }).click();
    await confirmOnPage(page, `${username}@localhost`, "Desktop app");
    await appCompletes(request, s, `${username}@localhost`, "Desktop app");
  });

  test("an expired request and cancelling", async ({ page, request }) => {
    const account = await registerViaApi(request, "dcx");
    const login = await request.post(`${NODE}/api/v1/auth/login`, { data: { username: account.username, password: account.password } });
    const pre = await login.json();
    const verify = await request.post(`${NODE}/api/v1/auth/second-factor/verify`, { data: { preauth_token: pre.preauth_token, totp_code: await nextTotpCode(account) } });
    const session = await verify.json();
    await page.addInitScript(
      ({ token, refresh, username, id, deviceId }) => {
        localStorage.setItem("tavrn.auth", JSON.stringify({ token, refresh, deviceId, user: { id, username, domain: "localhost", address: `${username}@localhost`, display_name: username, kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: false } }));
      },
      { token: session.access_token, refresh: session.refresh_token, username: account.username, id: session.user.id, deviceId: session.device_id },
    );
    await page.goto(`/connect?session=${"A".repeat(43)}&state=${"s".repeat(22)}`);
    await expect(page.getByTestId("connect-expired")).toContainText("abgelaufen");
    const s = await createAppSession(request, "Desktop app");
    await page.goto(s.url);
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.getByTestId("connect-cancelled")).toBeVisible();
    expect((await (await request.get(`${NODE}/api/v1/auth/connect/session/${s.id}`)).json()).status).toBe("pending");
  });
});
