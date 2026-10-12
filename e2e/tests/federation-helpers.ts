// SPDX-License-Identifier: Apache-2.0
/**
 * Two-node setup of the Playwright config (FEDERATION.md §13): nodes a.test and b.test with their own
 * web clients. The browser resolves both names to 127.0.0.1 (Chromium only).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADULT_DOB, type Account, enrollTotp, ensureDateOfBirth, loginViaApi } from "./helpers";

const nodePort = process.env.E2E_NODE_PORT ?? "8080";
const webPort = process.env.E2E_WEB_PORT ?? "5173";
const plus = (port: string, n: number) => String(Number(port) + n);

export const A = "a.test";
export const B = "b.test";
export const NODE_PORT_A = process.env.E2E_NODE_PORT_A ?? plus(nodePort, 2);
export const NODE_PORT_B = process.env.E2E_NODE_PORT_B ?? plus(nodePort, 1);
/** API bases for the test runner (loopback). */
export const NODE_A = `http://127.0.0.1:${NODE_PORT_A}`;
export const NODE_B = `http://127.0.0.1:${NODE_PORT_B}`;
/** Web clients as the browser sees them. */
export const WEB_A = `http://a.test:${process.env.E2E_WEB_PORT_A ?? plus(webPort, 2)}`;
export const WEB_B = `http://b.test:${process.env.E2E_WEB_PORT_B ?? plus(webPort, 1)}`;
/** The API of b.test as the browser reaches it (its `.well-known` `api`). */
export const BROWSER_API_B = `http://b.test:${NODE_PORT_B}`;
/**
 * The API of a.test as its `.well-known` names it: a.test delegates to another host (its `TAVRN_PUBLIC_URL`,
 * design note 4.2c), so the identity domain and the endpoint host differ.
 */
export const BROWSER_API_A = `http://127.0.0.1:${NODE_PORT_A}`;

/**
 * These specs need Chromium (host resolver rules, CDP authenticator) in its full build: the headless
 * shell ignores `--unsafely-treat-insecure-origin-as-secure`, so the web origins of a.test and b.test
 * would not be secure contexts (no WebCrypto, no WebAuthn). Spec files call
 * `test.use(FEDERATION_BROWSER)` at top level.
 */
export const FEDERATION_BROWSER = { channel: "chromium" } as const;

export function chromiumOnly() {
  test.skip(({ browserName }) => browserName !== "chromium", "two-node setup is Chromium only");
}

/**
 * Puts a home session into the browser for the web client at `web` before the app loads. With `remote`
 * the account belongs to another node than the one serving `web` (signed in with another node).
 */
export async function loginOn(page: Page, web: string, account: Pick<Account, "token" | "refresh" | "username" | "userId" | "deviceId">, home: { domain: string; remote: boolean }) {
  const user = { id: account.userId, username: account.username, domain: home.domain, address: `${account.username}@${home.domain}`, display_name: account.username, kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: false };
  const remoteHome = home.remote ? { domain: home.domain, base: home.domain === A ? BROWSER_API_A : BROWSER_API_B, ws: `${(home.domain === A ? BROWSER_API_A : BROWSER_API_B).replace("http", "ws")}/api/v1/ws` } : null;
  await page.addInitScript(
    ({ origin, state }) => {
      if (location.origin === origin) localStorage.setItem("tavrn.auth", JSON.stringify(state));
    },
    { origin: web, state: { token: account.token, refresh: account.refresh, deviceId: account.deviceId, user, home: remoteHome } },
  );
}

/** Federated session of `account` (home `homeBase`, domain `target`) on `targetBase`, over the API. */
export async function federatedSession(request: APIRequestContext, homeBase: string, token: string, target: string, targetBase: string): Promise<string> {
  const fed = await request.post(`${homeBase}/api/v1/federation/token`, { headers: { Authorization: `Bearer ${token}` }, data: { target } });
  expect(fed.ok(), await fed.text()).toBeTruthy();
  const login = await request.post(`${targetBase}/api/v1/auth/federated`, { data: { token: (await fed.json()).token, device_name: "e2e" } });
  expect(login.ok(), await login.text()).toBeTruthy();
  return (await login.json()).access_token as string;
}

/** The conversation index of the account on its home node. */
export async function indexOf(request: APIRequestContext, homeBase: string, token: string): Promise<{ version: number; items: Array<{ node: string; kind: string; room_id?: string | null }> }> {
  const resp = await request.get(`${homeBase}/api/v1/users/me/conversations-index`, { headers: { Authorization: `Bearer ${token}` } });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json();
}

/** The data directory of a.test or b.test (`data-dev/e2e-a`, `data-dev/e2e-b`): caches next to the node's database. */
export function dataDirOf(domain: string): string {
  return resolve(dirname(new URL(import.meta.url).pathname), `../../data-dev/e2e-${domain === A ? "a" : "b"}`);
}

/** Serializes a section across workers and projects (they share the nodes), with a lock directory next to the node's data. */
export async function withNodeLock<T>(domain: string, name: string, fn: () => Promise<T>): Promise<T> {
  const dir = dataDirOf(domain);
  mkdirSync(dir, { recursive: true });
  const lock = resolve(dir, `${name}.lock`);
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* lock vanished meanwhile */
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

/** The node admin of a.test or b.test (`TAVRN_ADMIN_USERS=fedadmin`), cached next to the node's database across runs. */
export async function fedAdmin(request: APIRequestContext, domain: string): Promise<Account> {
  const username = "fedadmin";
  const password = "passwort-fedadmin-xyz";
  const base = domain === A ? NODE_A : NODE_B;
  const name = domain === A ? "a" : "b";
  const cache = resolve(dataDirOf(domain), "fedadmin.json");
  return withNodeLock(domain, "fedadmin", async () => {
    const cached: Account | null = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : null;
    if (cached) {
      const me = await request.get(`${base}/api/v1/users/me`, { headers: { Authorization: `Bearer ${cached.token}` } });
      if (me.ok()) {
        await ensureDateOfBirth(request, cached.token, base);
        return cached;
      }
    }
    let account: Account;
    const reg = await request.post(`${base}/api/v1/auth/register`, { data: { username, password, device_name: "e2e", date_of_birth: ADULT_DOB } });
    if (reg.ok()) {
      const totp = await enrollTotp(request, (await reg.json()).preauth_token, base);
      const s = totp.session!;
      account = { username, password, token: s.access_token, refresh: s.refresh_token, userId: s.user.id, isNodeAdmin: s.user.is_node_admin, deviceId: s.device_id, totpSecret: totp.secret, recoveryCodes: totp.recoveryCodes, lastStep: totp.lastStep };
    } else if (reg.status() === 409 && cached) {
      const s = await loginViaApi(request, cached, "e2e", base);
      account = { ...cached, token: s.token, refresh: s.refresh, deviceId: s.deviceId };
    } else {
      throw new Error(`fedadmin on ${domain}: ${reg.status()} ${await reg.text()} (delete data-dev/e2e-${name}.db and data-dev/e2e-${name} to start over)`);
    }
    expect(account.isNodeAdmin).toBeTruthy();
    writeFileSync(cache, JSON.stringify(account));
    return account;
  });
}

/** Opens `path` (e.g. `/admin/reports`) in the web client of `domain` as its node admin `admin`. */
export async function openAdminOn(page: Page, domain: string, admin: Account, path: string) {
  const web = domain === A ? WEB_A : WEB_B;
  await loginOn(page, web, admin, { domain, remote: false });
  // `loginOn` stores a non-admin user; the admin page needs the flag.
  await page.addInitScript(
    ({ origin }) => {
      if (location.origin !== origin) return;
      const state = JSON.parse(localStorage.getItem("tavrn.auth") ?? "{}");
      if (state.user) state.user.is_node_admin = true;
      localStorage.setItem("tavrn.auth", JSON.stringify(state));
    },
    { origin: web },
  );
  await page.goto(`${web}${path}`);
}
