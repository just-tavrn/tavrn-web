// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys of the Linux app (docs/DESKTOP.md "Passkeys on Linux") with the software security key of a development build
 * (`TAVRN_DESKTOP_TEST_PASSKEYS`, `src/main/passkeys_mock.ts`) in place of the native module: the whole path except
 * the USB transport (bridge, origin from the settings, the shell's dialog with touch prompt, PIN and cancel, the client's
 * flows) against a real node, which verifies every credential as a browser's.
 *
 * - the bridge: the node's registration and sign-in options through `passkeyCreate` / `passkeyGet`, a wrong and the
 *   right PIN in the dialog (axe: WCAG 2.2 AA), the node accepts both answers, the PRF output comes apart; Escape
 *   cancels; a relying party outside the node's origin is refused without a dialog;
 * - the client: Settings → Security → Add passkey with the PIN in the dialog, signing out, "Sign in with a passkey":
 *   the passkey's PRF unlocks the encrypted messages without the recovery key.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { scaled } from "../../../e2e/tests/timeouts.ts";
import { nodeUrl, webOrigin } from "./harness.ts";
import { startApp, type ElectronApp } from "./launch.ts";
import { api, nextCode, registerAccount, type Account } from "./node-api.ts";

/** The software key's PIN (a test value). */
const PIN = "4321";
const env = { TAVRN_DESKTOP_TEST_PASSKEYS: `pin=${PIN}` };
/** The chosen node; its web client (the dev server) is the WebAuthn origin the node expects (`TAVRN_WEBAUTHN_ORIGIN`). */
const chosen = { node: nodeUrl, web: webOrigin, domain: "localhost" };
const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let run: ElectronApp | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

type Answer = { credential: Record<string, unknown>; prf: string | null };
type Passkeys = { passkeys: { passkeyCreate(o: unknown): Promise<Answer>; passkeyGet(o: unknown): Promise<Answer>; passkeyStatus(): Promise<unknown> } };

/** A bridge call from the page; the refusal as `{ refused }`. */
function ceremony(page: Page, method: "passkeyCreate" | "passkeyGet", options: unknown): Promise<{ value?: Answer; refused?: unknown }> {
  return page.evaluate(
    ([method, options]) => (window as unknown as { tavrnShell: Passkeys }).tavrnShell.passkeys[method](options).then((value) => ({ value }), (refused: unknown) => ({ refused })),
    [method, options] as const,
  );
}

/** Enters the PIN in the shell's dialog (the dialog's own page; the client's page never sees it). */
async function enterPin(dialog: Page, pin: string): Promise<void> {
  const field = dialog.locator("#passkey-pin");
  await expect(field).toBeFocused();
  await field.fill(pin);
  await field.press("Enter");
}

/** The account's confirmation for sensitive changes (PROTOCOL.md §5c): adding a passkey needs it. */
async function reauthHeaders(account: Account): Promise<Record<string, string>> {
  const r = await api<{ reauth_token: string }>("POST", "/auth/reauth", { password: account.password }, account.token);
  return { Authorization: `Bearer ${account.token}`, "Tavrn-Reauth": r.reauth_token, "Content-Type": "application/json" };
}

async function signInWithTotp(page: Page, account: Account): Promise<void> {
  await page.locator('input[name="username"]').fill(account.username);
  await page.locator('input[name="password"]').fill(account.password);
  await page.locator('input[name="password"]').press("Enter");
  const code = page.locator('input[name="totp_code"]');
  await code.fill(await nextCode(account));
  await code.press("Enter");
}

test("the bridge: the node's options, the PIN in the shell's dialog, the node accepts the answers", async ({}, info) => {
  test.setTimeout(scaled(180_000));
  const account = await registerAccount();
  run = await startApp({ settings: chosen, env });
  const { page } = run;
  await page.waitForFunction(() => typeof (window as unknown as { tavrnShell?: Partial<Passkeys> }).tavrnShell?.passkeys === "object");
  expect(await page.evaluate(() => (window as unknown as { tavrnShell: Passkeys }).tavrnShell.passkeys.passkeyStatus())).toEqual({ available: true, present: 1, usable: 1 });

  // Registration with the node's options; the dialog asks for the PIN, a wrong one first.
  const headers = await reauthHeaders(account);
  const start = await fetch(`${nodeUrl}/api/v1/auth/webauthn/register/start`, { method: "POST", headers, body: "{}" });
  expect(start.status).toBe(200);
  const reg = (await start.json()) as { challenge_id: string; options: unknown };
  const opened = run.waitForWindow();
  const created = ceremony(page, "passkeyCreate", reg.options);
  const dialog = await opened;
  await expect(dialog.locator("h1")).toHaveText("Create a passkey for localhost");
  await expect(dialog.locator("label")).toHaveText("PIN of the security key");
  const scan = await new AxeBuilder({ page: dialog }).setLegacyMode().withTags(A11Y_TAGS).analyze();
  await info.attach("axe-passkey-dialog.json", { body: JSON.stringify(scan.violations, null, 2), contentType: "application/json" });
  expect(scan.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("passkey-dialog-pin.png") });
  await enterPin(dialog, "0000");
  await expect(dialog.getByRole("alert")).toHaveText("Wrong PIN. 7 tries left before the key locks.");
  const closed = dialog.waitForEvent("close");
  await enterPin(dialog, PIN);
  await closed;
  const made = await created;
  expect(made.refused).toBeUndefined();
  const clientData = JSON.parse(Buffer.from(String((made.value!.credential.response as { clientDataJSON: string }).clientDataJSON), "base64url").toString()) as { origin: string };
  expect(clientData.origin).toBe(webOrigin);
  const finish = await fetch(`${nodeUrl}/api/v1/auth/webauthn/register/finish`, { method: "POST", headers, body: JSON.stringify({ challenge_id: reg.challenge_id, name: "Software key", response: made.value!.credential }) });
  const finished = (await finish.json()) as { credential: { prf_supported: boolean } };
  expect(finish.status, JSON.stringify(finished)).toBe(200);
  expect(finished.credential.prf_supported).toBe(true);

  // The passkey-only sign-in: the node's options without a list, the PIN, the node's session; the PRF output apart.
  const login = await api<{ challenge_id: string; options: unknown }>("POST", "/auth/webauthn/login/start", {});
  const opened2 = run.waitForWindow();
  const got = ceremony(page, "passkeyGet", login.options);
  const dialog2 = await opened2;
  await expect(dialog2.locator("h1")).toHaveText("Use your passkey for localhost");
  const closed2 = dialog2.waitForEvent("close");
  await enterPin(dialog2, PIN);
  await closed2;
  const used = await got;
  expect(used.refused).toBeUndefined();
  expect(JSON.stringify(used.value!.credential)).not.toContain("results");
  const session = await api<{ access_token?: string; user?: { username: string } }>("POST", "/auth/webauthn/login/finish", { challenge_id: login.challenge_id, response: used.value!.credential, device_name: "passkey spec" });
  expect(session.user?.username).toBe(account.username);

  // Escape in the dialog cancels; a relying party outside the node's origin never reaches the key.
  const login2 = await api<{ options: unknown }>("POST", "/auth/webauthn/login/start", {});
  const opened3 = run.waitForWindow();
  const cancelled = ceremony(page, "passkeyGet", login2.options);
  const dialog3 = await opened3;
  await expect(dialog3.locator("#passkey-pin")).toBeFocused();
  await dialog3.keyboard.press("Escape");
  expect(await cancelled).toEqual({ refused: "passkey.cancelled" });
  const noDialog = run.nextWindow(2_000);
  expect(await ceremony(page, "passkeyGet", { publicKey: { challenge: "AAAAAAAAAAAAAAAAAAAAAA", rpId: "evil.example" } })).toEqual({ refused: "passkey.refused" });
  expect(await noDialog).toBeNull();
});

test("the client: add a passkey in the settings, sign out, sign in with it: the PRF unlocks the messages", async ({}, info) => {
  test.setTimeout(scaled(240_000));
  const account = await registerAccount();
  run = await startApp({ settings: chosen, env });
  const app = run;
  const { page } = run;
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/, { timeout: 30_000 });
  await signInWithTotp(page, account);
  await expect(page.getByTestId("recovery-key-words")).toBeVisible({ timeout: 60_000 });
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });

  // Settings → Security → Add passkey: the key is "plugged in", so the form shows (no hint to plug one in).
  await page.evaluate(() => {
    history.pushState({}, "", "/settings/security");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByRole("button", { name: "Add passkey" }).click();
  await page.getByLabel("Name of the passkey", { exact: true }).fill("Software key");
  await expect(page.getByTestId("passkey-insert-key")).toHaveCount(0);
  const opened = app.waitForWindow();
  await page.getByRole("button", { name: "Add passkey" }).click();
  // The node may ask to confirm it is the user first (the password), before the ceremony starts.
  const reauth = page.getByTestId("reauth-dialog");
  const first = await Promise.race([opened.then(() => "dialog" as const), reauth.waitFor().then(() => "reauth" as const)]);
  if (first === "reauth") {
    await reauth.getByTestId("reauth-password").fill(account.password);
    await reauth.getByTestId("reauth-submit").click();
  }
  const dialog = await opened;
  await expect(dialog.locator("h1")).toHaveText("Create a passkey for localhost");
  // After the registration the client asks the new passkey once more, for the PRF output that adds the passkey as a
  // way to unlock the encrypted messages (a second touch and PIN, as in a browser).
  const opened2 = app.waitForWindow();
  await enterPin(dialog, PIN);
  const prfDialog = await opened2;
  await expect(prfDialog.locator("h1")).toHaveText("Use your passkey for localhost");
  const closedPrf = prfDialog.waitForEvent("close");
  await enterPin(prfDialog, PIN);
  await closedPrf;
  const item = page.getByTestId("passkey-list").locator("li").filter({ hasText: "Software key" });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Passkey added; it can also unlock your encrypted messages")).toBeVisible();
  await page.screenshot({ path: info.outputPath("passkey-added.png") });

  // Sign out (the device's keys go), then the passkey on the login page: its PRF opens the secret storage.
  await page.getByTestId("presence-menu-button").click();
  await page.getByTestId("presence-logout").click();
  await page.getByTestId("logout-dialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/^app:\/\/tavrn\/login/, { timeout: 30_000 });
  const opened3 = app.waitForWindow();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const dialog3 = await opened3;
  const closed3 = dialog3.waitForEvent("close");
  await enterPin(dialog3, PIN);
  await closed3;
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("recovery-key-input")).toHaveCount(0);
  await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("signed-in-with-passkey.png") });
});
