// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { scaled } from "./timeouts.ts";

export const NODE = `http://127.0.0.1:${process.env.E2E_NODE_PORT ?? "8080"}`;

// ---- Pages, messages, locks (shared by the specs instead of a copy in each) ---------------------------------------

/** Contexts opened with {@link newPage}; a spec that uses it closes them with `test.afterEach(closePages)`. */
const pageContexts: BrowserContext[] = [];

/** A page in a fresh browser context of the test's project (its own storage: another user or device). */
export async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...test.info().project.use });
  pageContexts.push(context);
  return context.newPage();
}

/** Closes the contexts {@link newPage} opened (each holds the node's sockets and, in calls, LiveKit ports). */
export async function closePages(): Promise<void> {
  for (const c of pageContexts.splice(0)) await c.close().catch(() => undefined);
}

/** Sends `text` from the open conversation's composer once it can send (keys and history loaded). */
export async function send(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Nachricht", { exact: true });
  await expect(box).toBeEnabled({ timeout: scaled(20_000) });
  await box.fill(text);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
}

/** The message with `text` in the open conversation. */
export const message = (page: Page, text: string) => page.getByTestId("message").filter({ hasText: text });

/** How often a lock's holder marks it as alive. */
const LOCK_HEARTBEAT_MS = 5_000;
/**
 * A lock nobody marked as alive for this long belongs to a worker that died (its holder refreshes it every
 * {@link LOCK_HEARTBEAT_MS}, however long it holds it); scaled like every wait, so a slow runner never loses a lock.
 */
export const LOCK_STALE_MS = scaled(60_000);

/**
 * Runs `fn` while holding the lock directory `lock` (created next to the node's data): serializes a section across
 * workers and projects. The holder keeps the lock fresh while it runs; a stale one (its holder died) is taken over.
 */
export async function withFileLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* the lock vanished meanwhile */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      /* removed by the holder's finally */
    }
  }, LOCK_HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The accessible name of a room in the rail: its name, then its counts and voice activity when there are any
 * ("Gilde, 1 ungelesen, 2 im Sprachkanal", docs/CLIENT.md "Room rail and folders").
 */
export function railName(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(, .+)?$`);
}

export function uniqueName(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.toLowerCase();
}

export interface Account {
  username: string;
  password: string;
  token: string;
  refresh: string;
  userId: string;
  isNodeAdmin: boolean;
  deviceId: string;
  /** Base32 TOTP secret enrolled for the account. */
  totpSecret: string;
  /** Unused recovery codes. */
  recoveryCodes: string[];
  /** Last TOTP step the node accepted (replay guard: only newer steps are accepted). */
  lastStep: number;
}

// ---- TOTP (RFC 6238: SHA-1, 6 digits, 30-second steps) ---------------------------------------

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return bin.toString().padStart(6, "0");
}

export const currentStep = () => Math.floor(Date.now() / 30_000);

/**
 * A code the node accepts now: newer than the last accepted step (replay guard) and within ±1 step.
 * Waits for the next 30-second window if both the current and the next step were used already.
 */
export async function nextTotpCode(account: Pick<Account, "totpSecret" | "lastStep">): Promise<string> {
  let step = Math.max(currentStep(), account.lastStep + 1);
  while (step > currentStep() + 1) await new Promise((r) => setTimeout(r, 1000));
  step = Math.max(currentStep(), account.lastStep + 1);
  account.lastStep = step;
  return totpCode(account.totpSecret, step);
}

// ---- Accounts over the API ------------------------------------------------------------------

interface Session {
  access_token: string;
  refresh_token: string;
  device_id: string;
  user: { id: string; is_node_admin: boolean };
}

async function post(request: APIRequestContext, path: string, data: unknown, token?: string, base = NODE) {
  return request.post(`${base}/api/v1${path}`, { data, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/** Enrolls TOTP with a pre-auth token (stage `enroll`) or a session; returns the secret, codes and session. */
export async function enrollTotp(request: APIRequestContext, bearer: string, base = NODE) {
  const enroll = await post(request, "/auth/totp/enroll", {}, bearer, base);
  if (!enroll.ok()) throw new Error(`totp/enroll: ${enroll.status()} ${await enroll.text()}`);
  const { secret } = await enroll.json();
  const holder = { totpSecret: secret as string, lastStep: 0 };
  const code = await nextTotpCode(holder);
  const confirm = await post(request, "/auth/totp/confirm", { code }, bearer, base);
  if (!confirm.ok()) throw new Error(`totp/confirm: ${confirm.status()} ${await confirm.text()}`);
  const json = await confirm.json();
  return { secret: holder.totpSecret, lastStep: holder.lastStep, recoveryCodes: (json.recovery_codes ?? []) as string[], session: json.session as Session | null };
}

function toAccount(username: string, password: string, session: Session, totp: { secret: string; lastStep: number; recoveryCodes: string[] }): Account {
  return {
    username,
    password,
    token: session.access_token,
    refresh: session.refresh_token,
    userId: session.user.id,
    isNodeAdmin: !!session.user.is_node_admin,
    deviceId: session.device_id,
    totpSecret: totp.secret,
    recoveryCodes: [...totp.recoveryCodes],
    lastStep: totp.lastStep,
  };
}

/** The date of birth the helpers register with: an adult (protocol PROTOCOL.md §5e). */
export const ADULT_DOB = "1990-01-01";

/** A date of birth `years` years ago today (UTC), e.g. a 16-year-old for the age gate specs. */
export function bornYearsAgo(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * Accounts of databases from before `age.v1` (cached admins of earlier runs) have no date of birth yet: add the adult
 * default once (a second call answers 409 and changes nothing).
 */
export async function ensureDateOfBirth(request: APIRequestContext, token: string, base = NODE): Promise<void> {
  await request.put(`${base}/api/v1/users/me/date-of-birth`, { headers: { Authorization: `Bearer ${token}` }, data: { date_of_birth: ADULT_DOB } });
}

/** The blocking "add your date of birth" dialog (accounts provisioned by single sign-on): fills it in. */
export async function completeDateOfBirth(page: Page, dateOfBirth = ADULT_DOB): Promise<void> {
  const dialog = page.getByTestId("dob-dialog");
  await expect(dialog).toBeVisible({ timeout: scaled(20_000) });
  await dialog.getByLabel("Geburtsdatum", { exact: true }).fill(dateOfBirth);
  await page.getByTestId("dob-save").click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Creates an account over the API, including the mandatory TOTP enrollment (faster than the UI). `base`
 * selects the node (the federation specs use a.test and b.test).
 */
export async function registerViaApi(request: APIRequestContext, prefix = "user", base = NODE, dateOfBirth = ADULT_DOB): Promise<Account> {
  const username = uniqueName(prefix);
  const password = `passwort-${username}-xyz`;
  const resp = await post(request, "/auth/register", { username, password, device_name: "e2e", date_of_birth: dateOfBirth }, undefined, base);
  if (!resp.ok()) throw new Error(`register: ${resp.status()} ${await resp.text()}`);
  const pre = await resp.json();
  const totp = await enrollTotp(request, pre.preauth_token, base);
  return toAccount(username, password, totp.session!, totp);
}

/**
 * Password + TOTP login over the API (a new device). Falls back to a recovery code if the TOTP code
 * is refused (another login used the step in between).
 */
export async function loginViaApi(request: APIRequestContext, account: Account, deviceName = "e2e", base = NODE): Promise<{ token: string; refresh: string; deviceId: string }> {
  const resp = await post(request, "/auth/login", { username: account.username, password: account.password, device_name: deviceName }, undefined, base);
  if (!resp.ok()) throw new Error(`login: ${resp.status()} ${await resp.text()}`);
  const pre = await resp.json();
  if (pre.status !== "second_factor_required") throw new Error(`login: unexpected status ${pre.status}`);
  let verify = await post(request, "/auth/second-factor/verify", { preauth_token: pre.preauth_token, totp_code: await nextTotpCode(account) }, undefined, base);
  if (verify.status() === 401 && account.recoveryCodes.length) {
    verify = await post(request, "/auth/second-factor/verify", { preauth_token: pre.preauth_token, recovery_code: account.recoveryCodes.shift() }, undefined, base);
  }
  if (!verify.ok()) throw new Error(`second factor: ${verify.status()} ${await verify.text()}`);
  const s = (await verify.json()) as Session;
  return { token: s.access_token, refresh: s.refresh_token, deviceId: s.device_id };
}

/** Puts a session into the browser before the app loads (skips the sign-in UI). */
export async function loginAs(page: Page, account: Account) {
  await page.addInitScript(
    ({ token, refresh, username, id, admin, deviceId }) => {
      localStorage.setItem(
        "tavrn.auth",
        JSON.stringify({ token, refresh, deviceId, user: { id, username, domain: "localhost", address: `${username}@localhost`, display_name: username, kind: "user", is_node_admin: admin, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: false } }),
      );
    },
    { token: account.token, refresh: account.refresh, username: account.username, id: account.userId, admin: account.isNodeAdmin, deviceId: account.deviceId },
  );
}

/**
 * Creates a room over the API. Its default text channel is end-to-end encrypted; accounts created
 * over the API have no encryption keys, so unless `encrypted` is set the channel is switched to
 * plaintext (which posts the "encryption turned off" system message). Public rooms are also listed in
 * the directory (`discoverable`, so they appear under Discover) unless `discoverable: false`.
 */
export async function createRoomViaApi(request: APIRequestContext, token: string, name: string, join_mode = "invite", opts: { encrypted?: boolean; base?: string; discoverable?: boolean } = {}) {
  const base = opts.base ?? NODE;
  const resp = await request.post(`${base}/api/v1/rooms`, { headers: { Authorization: `Bearer ${token}` }, data: { name, join_mode } });
  if (!resp.ok()) throw new Error(`create room: ${resp.status()} ${await resp.text()}`);
  const room = await resp.json();
  if (opts.discoverable ?? join_mode === "public") {
    const listed = await request.patch(`${base}/api/v1/rooms/${room.id}`, { headers: { Authorization: `Bearer ${token}` }, data: { discoverable: true } });
    if (!listed.ok()) throw new Error(`discoverable: ${listed.status()} ${await listed.text()}`);
    room.discoverable = true;
  }
  if (!opts.encrypted) {
    const channel = room.channels.find((c: { kind: string }) => c.kind === "text");
    const patch = await request.patch(`${base}/api/v1/rooms/${room.id}/channels/${channel.id}`, { headers: { Authorization: `Bearer ${token}` }, data: { encrypted: false } });
    if (!patch.ok()) throw new Error(`plaintext channel: ${patch.status()} ${await patch.text()}`);
    channel.encrypted = false;
  }
  return room;
}

/** Invite link code for a room (owner token). */
export async function inviteCode(request: APIRequestContext, token: string, roomId: string): Promise<string> {
  const resp = await request.post(`${NODE}/api/v1/rooms/${roomId}/invites`, { headers: { Authorization: `Bearer ${token}` }, data: {} });
  if (!resp.ok()) throw new Error(`invite: ${resp.status()} ${await resp.text()}`);
  return (await resp.json()).code as string;
}

/** On phones the room rail and channel list live in a drawer; open it before clicking there. */
export async function openNavIfMobile(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width >= 768) return;
  const drawer = page.getByTestId("nav-drawer");
  if ((await drawer.getAttribute("data-open")) === "true") return;
  await page.getByTestId("nav-toggle").tap();
}

/**
 * The room header of the sidebar is one menu button (icon, name, chevron); "Invite people" is the room menu's first
 * entry. Opens the navigation drawer on phones first.
 */
export async function openRoomInvite(page: Page) {
  await openNavIfMobile(page);
  await page.getByTestId("room-header-menu").click();
  await page.getByTestId("room-menu").getByRole("menuitem", { name: "Leute einladen" }).click();
}

/**
 * Logout lives at the bottom of the presence menu behind a confirmation (design note 4.11). The caller opens
 * the navigation drawer on phones first (the footer with the menu is inside it).
 */
export async function logoutViaUi(page: Page) {
  await page.getByTestId("presence-menu-button").click();
  await page.getByTestId("presence-logout").click();
  await page.getByTestId("logout-dialog").getByRole("button", { name: "Abmelden", exact: true }).click();
}

// ---- Node admin -----------------------------------------------------------------------------

// The admin account is fixed (TAVRN_ADMIN_USERS in the Playwright config) and survives runs in the
// e2e database, so its TOTP secret, recovery codes and session are cached next to the database
// (deleted together with it). A directory lock serializes parallel workers.
const ADMIN_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../../data-dev/e2e");
const ADMIN_CACHE = resolve(ADMIN_DIR, "e2eadmin.json");
const ADMIN_LOCK = resolve(ADMIN_DIR, "e2eadmin.lock");

const withAdminLock = <T>(fn: () => Promise<T>): Promise<T> => withFileLock(ADMIN_LOCK, fn);

/** Node admin for tests: fixed username from TAVRN_ADMIN_USERS of the Playwright config. */
export async function adminAccount(request: APIRequestContext): Promise<Account> {
  const username = "e2eadmin";
  const password = "passwort-e2eadmin-xyz";
  return withAdminLock(async () => {
    const cached: Account | null = existsSync(ADMIN_CACHE) ? JSON.parse(readFileSync(ADMIN_CACHE, "utf8")) : null;
    if (cached) {
      const me = await request.get(`${NODE}/api/v1/users/me`, { headers: { Authorization: `Bearer ${cached.token}` } });
      if (me.ok()) {
        await ensureDateOfBirth(request, cached.token);
        return cached;
      }
    }
    let account: Account;
    const reg = await post(request, "/auth/register", { username, password, device_name: "e2e", date_of_birth: ADULT_DOB });
    if (reg.ok()) {
      const totp = await enrollTotp(request, (await reg.json()).preauth_token);
      account = toAccount(username, password, totp.session!, totp);
    } else if (reg.status() === 409 && cached) {
      const s = await loginViaApi(request, cached);
      account = { ...cached, token: s.token, refresh: s.refresh, deviceId: s.deviceId };
    } else if (reg.status() === 409) {
      // Database from before the mandatory second factor: the account has none yet.
      const login = await post(request, "/auth/login", { username, password, device_name: "e2e" });
      const pre = await login.json();
      if (pre.status !== "enrollment_required") throw new Error("e2eadmin exists without a cached TOTP secret: delete data-dev/e2e.db and data-dev/e2e");
      const totp = await enrollTotp(request, pre.preauth_token);
      account = toAccount(username, password, totp.session!, totp);
    } else {
      throw new Error(`admin account: ${reg.status()} ${await reg.text()}`);
    }
    await ensureDateOfBirth(request, account.token);
    writeFileSync(ADMIN_CACHE, JSON.stringify(account));
    return account;
  });
}

// ---- UI flows -------------------------------------------------------------------------------

export interface UiAccount {
  username: string;
  password: string;
  address: string;
  totpSecret: string;
  lastStep: number;
  recoveryWords: string;
  recoveryCodes: string[];
}

/** Recovery key step: reads the 24 words, confirms and finishes. Returns the words. */
export async function confirmRecoveryKey(page: Page, buttonName = "Einrichtung abschließen"): Promise<string> {
  const words = page.getByTestId("recovery-key-words");
  await expect(words).toBeVisible();
  const text = (await words.getAttribute("data-words"))!;
  expect(text.split(" ")).toHaveLength(24);
  const finish = page.getByRole("button", { name: buttonName, exact: true });
  await expect(finish).toBeDisabled();
  await page.getByLabel("Ich habe meinen Wiederherstellungsschlüssel gesichert", { exact: true }).check();
  await finish.click();
  return text;
}

/** Recovery codes step: reads the ten codes and continues. */
export async function confirmRecoveryCodes(page: Page, buttonName = "Weiter"): Promise<string[]> {
  const list = page.getByTestId("recovery-codes");
  await expect(list.locator("li")).toHaveCount(10);
  const codes = await list.locator("li").allTextContents();
  await page.getByLabel("Ich habe die Codes sicher aufbewahrt", { exact: true }).check();
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  return codes.map((c) => c.trim());
}

/** Enrolls TOTP in the wizard: reads the secret shown for manual entry and types the current code. */
export async function enrollTotpInUi(page: Page): Promise<{ totpSecret: string; lastStep: number }> {
  await page.getByTestId("choose-totp").click();
  await expect(page.getByTestId("totp-qr")).toBeVisible();
  const holder = { totpSecret: (await page.getByTestId("totp-secret").textContent())!.trim(), lastStep: 0 };
  await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(holder));
  await page.getByRole("button", { name: "Aktivieren", exact: true }).click();
  return holder;
}

/** Full registration through the wizard with TOTP; ends in the app. */
export async function registerViaUi(page: Page, opts: { prefix?: string; displayName?: string; web?: string; domain?: string; dateOfBirth?: string } = {}): Promise<UiAccount> {
  const username = uniqueName(opts.prefix ?? "ui");
  const password = `passwort-${username}-xyz`;
  await page.goto(`${opts.web ?? ""}/login`);
  await page.getByRole("tab", { name: "Registrieren" }).click();
  await page.getByLabel("Benutzername", { exact: true }).fill(username);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByLabel("Passwort wiederholen", { exact: true }).fill(password);
  await page.getByLabel("Geburtsdatum", { exact: true }).fill(opts.dateOfBirth ?? ADULT_DOB);
  if (opts.displayName) await page.getByLabel("Anzeigename (optional)", { exact: true }).fill(opts.displayName);
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await expect(page.getByRole("heading", { name: "Zweiten Faktor einrichten" })).toBeVisible();
  const totp = await enrollTotpInUi(page);
  await expect(page.getByRole("heading", { name: "Deine Wiederherstellungscodes" })).toBeVisible();
  const recoveryCodes = await confirmRecoveryCodes(page);
  await expect(page.getByTestId("wizard-steps")).toContainText("Schritt 4 von 4");
  const recoveryWords = await confirmRecoveryKey(page);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("e2ee-banner")).toHaveCount(0);
  return { username, password, address: `${username}@${opts.domain ?? "localhost"}`, ...totp, recoveryWords, recoveryCodes };
}

/** Password + TOTP sign-in through the UI. */
export async function loginViaUi(page: Page, account: { username: string; password: string; totpSecret: string; lastStep: number }, web = "") {
  await page.goto(`${web}/login`);
  await page.getByLabel("Benutzername", { exact: true }).fill(account.username);
  await page.getByLabel("Passwort", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Anmeldung bestätigen" })).toBeVisible();
  await page.getByLabel("6-stelliger Code", { exact: true }).fill(await nextTotpCode(account));
  await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
}

/**
 * Sudo mode (PROTOCOL.md §5c): confirms the open re-authentication dialog with the password. The login's confirmation
 * lives in memory only, so the first sensitive change after a page load asks for it.
 */
export async function confirmWithPassword(page: Page, password: string) {
  const reauth = page.getByTestId("reauth-dialog");
  await reauth.getByTestId("reauth-password").fill(password);
  await reauth.getByTestId("reauth-submit").click();
  await expect(reauth).toHaveCount(0);
}

/** Access token of the session the web app holds. */
export async function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}").token as string);
}

/**
 * Chromium virtual authenticator (CDP) with resident keys and user verification. PRF support of the
 * virtual authenticator depends on the Chromium version: `prf` tells whether `hasPrf` was accepted. `remove` unplugs
 * it (its passkeys with it), so a second one can register another passkey for the same account (the registration
 * excludes the account's passkeys, and an authenticator that holds one refuses). `{ prf: false }` adds one without
 * the extension (hmac-secret) at all.
 */
export async function addVirtualAuthenticator(page: Page, want: { prf?: boolean } = {}): Promise<{ prf: boolean; remove: () => Promise<void> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const options = { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };
  const add = async (opts: object) => {
    const { authenticatorId } = (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: opts } as never)) as unknown as { authenticatorId: string };
    return { remove: async () => void (await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId } as never)) };
  };
  if (want.prf === false) return { prf: false, ...(await add(options)) };
  try {
    return { prf: true, ...(await add({ ...options, hasPrf: true })) };
  } catch {
    return { prf: false, ...(await add(options)) };
  }
}

/**
 * Makes the next registrations of the current page announce no PRF: the client extension results of
 * `navigator.credentials.create` lose `prf`, as on an authenticator that reports the extension only when used (Windows
 * Hello after an update). The authenticator itself still evaluates it at assertion time. Lasts until a navigation.
 */
export async function hidePrfAtRegistration(page: Page) {
  await page.evaluate(() => {
    const container = navigator.credentials;
    const create = container.create.bind(container);
    container.create = async (options?: CredentialCreationOptions) => {
      const cred = (await create(options)) as PublicKeyCredential | null;
      if (cred) {
        const ext = { ...cred.getClientExtensionResults() } as Record<string, unknown>;
        delete ext.prf;
        Object.defineProperty(cred, "getClientExtensionResults", { value: () => ({ ...ext }) });
      }
      return cred;
    };
  });
}

/** The re-authentication dialog, if the last confirmation expired (PROTOCOL.md §5c, five minutes): confirms with the password. */
export async function confirmWithPasswordIfAsked(page: Page, password: string) {
  const reauth = page.getByTestId("reauth-dialog");
  const asked = await reauth.waitFor({ state: "visible", timeout: scaled(2_000) }).then(() => true, () => false);
  if (asked) await confirmWithPassword(page, password);
}
