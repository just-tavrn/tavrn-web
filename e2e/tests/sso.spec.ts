// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADULT_DOB, NODE, adminAccount, completeDateOfBirth, confirmRecoveryKey, confirmWithPassword, createRoomViaApi, enrollTotp, loginAs, nextTotpCode, registerViaApi, tokenOf, uniqueName } from "./helpers";
import { createRole, openMembers } from "./menu-helpers";
import { logoutViaUi, openNavIfMobile } from "./helpers";
import { scaled } from "./timeouts";

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "5173"}`;
const DATA = resolve(dirname(new URL(import.meta.url).pathname), "../../data-dev");

// Single sign-on via OpenID Connect (APPLICATIONS.md §8) against e2e/fixtures/fake-oidc.mjs. The main node
// trusts the provider; a second node runs with TAVRN_OIDC_ONLY (break-glass account `ssoadmin`).
const nodePort = process.env.E2E_NODE_PORT ?? "8080";
const webPort = process.env.E2E_WEB_PORT ?? "5173";
const plus = (port: string, n: number) => String(Number(port) + n);
const SSO_NODE = `http://127.0.0.1:${process.env.E2E_NODE_PORT_SSO ?? plus(nodePort, 5)}`;
const SSO_WEB = `http://localhost:${process.env.E2E_WEB_PORT_SSO ?? plus(webPort, 5)}`;

/** At the fake provider's sign-in form: sign in as `username` with `groups`. */
async function signInAtProvider(page: Page, username: string, groups: string[] = []) {
  await expect(page.getByRole("heading", { name: "Fake IdP sign-in" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Display name").fill(`${username} (IdP)`);
  if (groups.length) await page.getByLabel("Groups").fill(groups.join(", "));
  await page.getByRole("button", { name: "Sign in at the IdP" }).click();
}

/** SSO login from the login page of `web` up to the end of the recovery key setup (first login). */
async function firstSsoLogin(page: Page, username: string, groups: string[] = [], web = "") {
  await page.goto(`${web}/login`);
  await page.getByTestId("sso-button").click();
  await signInAtProvider(page, username, groups);
  // No second factor: straight to the encryption setup (APPLICATIONS.md §8.4).
  await expect(page.getByTestId("encryption-title")).toHaveText("Dein Wiederherstellungsschlüssel", { timeout: 20_000 });
  await expect(page.getByTestId("encryption-account")).toHaveText(`${username}@localhost`);
  // A provisioned account adds its date of birth first (PROTOCOL.md §5e).
  await completeDateOfBirth(page);
}

/** Serializes work on node-wide state (the group map, the break-glass account) across parallel workers. */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const lock = resolve(DATA, `e2e/${name}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* vanished meanwhile */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

test.describe("Single Sign-on (APPLICATIONS.md §8)", () => {
  test("SSO button, first sign-in at the provider without a second factor, recovery key, sign-out at the provider", async ({ page }) => {
    const username = uniqueName("sso");
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Mit SSO anmelden" })).toBeVisible();
    await expect(page.getByLabel("Passwort", { exact: true })).toBeVisible();
    await firstSsoLogin(page, username);
    await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);

    // SSO-only accounts have no password to change; the SSO section shows the link.
    await page.goto("/settings/security");
    await expect(page.getByTestId("sso-linked")).toBeVisible();
    await expect(page.getByText("Passwort ändern")).toHaveCount(0);

    // Sign-out offers the provider's logout as well (§8.6).
    await openNavIfMobile(page);
    await logoutViaUi(page);
    const providerLogout = page.getByRole("link", { name: "Auch beim Identitätsanbieter abmelden" });
    await expect(providerLogout).toBeVisible();
    await expect(providerLogout).toHaveAttribute("href", /\/logout\?client_id=tavrn-e2e&post_logout_redirect_uri=/);

    // A cancelled sign-in at the provider comes back with a translated error.
    await page.getByTestId("sso-button").click();
    await expect(page.getByRole("heading", { name: "Fake IdP sign-in" })).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByTestId("sso-error")).toContainText("Der Identitätsanbieter hat die Anmeldung abgelehnt. (access_denied)");
  });

  test("An SSO account sets up the recovery key like password accounts and has an identity afterwards (design note 4.13 item 10)", async ({ page, browser, request }) => {
    test.setTimeout(scaled(90_000));
    const username = uniqueName("ssoid");
    await firstSsoLogin(page, username);
    // The same recovery key step as for password accounts (helpers.registerViaUi): 24 words, the finish
    // button stays disabled until the backup is confirmed.
    const words = await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);

    // The account now has an identity key, a device key and the recovery-wrapped master secret on its node.
    const auth = { headers: { Authorization: `Bearer ${await tokenOf(page)}` } };
    const me = await (await request.get(`${NODE}/api/v1/users/me`, auth)).json();
    expect(me.has_identity_key).toBe(true);
    const storage = await (await request.get(`${NODE}/api/v1/users/me/secret-storage`, auth)).json();
    expect(storage.items.map((i: { method: string }) => i.method)).toContain("recovery");
    expect((await (await request.get(`${NODE}/api/v1/users/${username}/keys`)).json()).devices).toHaveLength(1);

    // A second device signs in through the provider and unlocks the existing identity with the recovery key,
    // exactly like a password account on a new device (no new identity is created).
    const other = await browser.newContext({ ...test.info().project.use });
    const page2 = await other.newPage();
    await page2.goto(`${WEB}/login`);
    await page2.getByTestId("sso-button").click();
    await signInAtProvider(page2, username);
    await expect(page2.getByTestId("encryption-title")).toHaveText("Verschlüsselte Nachrichten entsperren", { timeout: 20_000 });
    await page2.getByTestId("recovery-key-input").fill(words);
    await page2.getByRole("button", { name: "Entsperren", exact: true }).click();
    await expect(page2.getByTestId("app-shell")).toBeVisible();
    await expect(page2.getByTestId("e2ee-banner")).toHaveCount(0);
    expect((await (await request.get(`${NODE}/api/v1/users/${username}/keys`)).json()).devices).toHaveLength(2);
    const after = await (await request.get(`${NODE}/api/v1/users/me`, auth)).json();
    expect(after.has_identity_key).toBe(true);
    await other.close();
  });

  test("Link an existing password account in the security settings, then sign in via SSO", async ({ page, browser, request }) => {
    const account = await registerViaApi(request, "link");
    const idpName = uniqueName("idp");
    await loginAs(page, account);
    await page.goto("/settings/security");
    const section = page.getByTestId("sso-section");
    await expect(section).toContainText("Dein Konto ist nicht mit dem Identitätsanbieter verknüpft.");
    // Linking adds a way to sign in: it needs a fresh confirmation (PROTOCOL.md §5c), asked before the provider opens.
    await section.getByTestId("sso-link").click();
    await expect(page.getByTestId("reauth-dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fake IdP sign-in" })).toHaveCount(0);
    await confirmWithPassword(page, account.password);
    await signInAtProvider(page, idpName);
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(page.getByRole("status").filter({ hasText: "SSO-Konto verknüpft" })).toBeVisible();
    await expect(page.getByTestId("sso-linked")).toBeVisible();

    // A fresh browser: the SSO login lands in the linked password account, without its second factor.
    const context = await browser.newContext();
    const other = await context.newPage();
    await other.goto(`${WEB}/login`);
    await other.getByTestId("sso-button").click();
    await signInAtProvider(other, idpName);
    await expect(other.getByTestId("encryption-account")).toHaveText(`${account.username}@localhost`, { timeout: 20_000 });
    await context.close();

    // Unlinking is allowed after a confirmation: the account keeps its password and second factor.
    await page.getByTestId("sso-unlink").click();
    await confirmWithPassword(page, account.password);
    await expect(page.getByTestId("sso-link")).toBeVisible();
  });

  test("The provider's groups become roles: visible in the member list", async ({ page, request }) => {
    const admin = await adminAccount(request);
    const room = await createRoomViaApi(request, admin.token, "SSO-Team");
    const role = await createRole(request, admin, room.id, { name: "SSO-Devs", hoist: true, position: 2 });
    const group = uniqueName("devs");
    const username = uniqueName("grp");
    await withLock("sso-map", async () => {
      const put = await request.put(`http://127.0.0.1:${nodePort}/api/v1/admin/sso/group-map`, {
        headers: { Authorization: `Bearer ${admin.token}` },
        data: { map: { [group]: { rooms: [{ room: room.id, roles: [role.id] }] } } },
      });
      expect(put.ok(), await put.text()).toBeTruthy();
      await firstSsoLogin(page, username, [group]);
    });
    await confirmRecoveryKey(page);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.goto(`/rooms/${room.id}`);
    await expect(page.getByTestId("channel-name")).toHaveText("allgemein");
    await openMembers(page);
    await expect(page.locator('[data-section="SSO-Devs"]')).toContainText(username);
  });
});


test.describe("TAVRN_OIDC_ONLY", () => {
  interface BreakGlass {
    username: string;
    password: string;
    totpSecret: string;
    lastStep: number;
  }
  const CACHE = resolve(DATA, "e2e-sso/ssoadmin.json");

  /** The break-glass account of the SSO-only node (TAVRN_ADMIN_USERS=ssoadmin); cached with its TOTP secret. */
  async function breakGlassAccount(request: APIRequestContext): Promise<BreakGlass> {
    if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8")) as BreakGlass;
    const username = "ssoadmin";
    const password = "passwort-ssoadmin-xyz";
    const reg = await request.post(`${SSO_NODE}/api/v1/auth/register`, { data: { username, password, device_name: "e2e", date_of_birth: ADULT_DOB } });
    if (reg.status() === 409) throw new Error("ssoadmin exists without data-dev/e2e-sso/ssoadmin.json: delete data-dev/e2e-sso.db and data-dev/e2e-sso");
    expect(reg.status(), await reg.text()).toBe(201);
    const totp = await enrollTotp(request, (await reg.json()).preauth_token, SSO_NODE);
    const account = { username, password, totpSecret: totp.secret, lastStep: totp.lastStep };
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(account));
    return account;
  }

  test("SSO only: password form for administrators only (emergency access)", async ({ page, browser, request }) => {
    // The break-glass account is one account for every run (both projects, retries, --repeat-each): the node takes each
    // TOTP step once, so a sign-in may wait up to 30 s for the next step, and the other worker waits for the lock
    // meanwhile. The default 30 s budget left no room for that.
    test.setTimeout(scaled(120_000));
    // Registration is closed for everybody but the break-glass names.
    const refused = await request.post(`${SSO_NODE}/api/v1/auth/register`, { data: { username: uniqueName("nope"), password: "passwort-nope-12345" } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe("auth.password_login_disabled");

    await page.goto(`${SSO_WEB}/login`);
    await expect(page.getByTestId("sso-only")).toBeVisible();
    await expect(page.getByTestId("sso-button")).toBeVisible();
    await expect(page.getByLabel("Passwort", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Anmeldung für Administratoren" }).click();
    await page.getByLabel("Benutzername", { exact: true }).fill(uniqueName("user"));
    await page.getByLabel("Passwort", { exact: true }).fill("passwort-irgendwas-1");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.getByText("Dieser Knoten erlaubt nur Single Sign-on.")).toBeVisible();

    // The operator signs in with password and second factor as usual (one worker at a time: TOTP replay guard).
    await withLock("ssoadmin", async () => {
      const admin = await breakGlassAccount(request);
      await page.getByLabel("Benutzername", { exact: true }).fill(admin.username);
      await page.getByLabel("Passwort", { exact: true }).fill(admin.password);
      await page.getByRole("button", { name: "Anmelden", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Anmeldung bestätigen" })).toBeVisible();
      await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(admin));
      await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
      writeFileSync(CACHE, JSON.stringify(admin));
      await expect(page.getByTestId("encryption-account")).toHaveText("ssoadmin@localhost", { timeout: 20_000 });
    });

    // Everybody else signs in through the provider.
    const context = await browser.newContext();
    const ssoPage = await context.newPage();
    await firstSsoLogin(ssoPage, uniqueName("only"), [], SSO_WEB);
    await context.close();
  });
});
