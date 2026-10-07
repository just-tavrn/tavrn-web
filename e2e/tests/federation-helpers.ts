// SPDX-License-Identifier: Apache-2.0
/**
 * Two-node setup of the Playwright config (FEDERATION.md §13): nodes a.test and b.test with their own
 * web clients. The browser resolves both names to 127.0.0.1 (Chromium only).
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Account } from "./helpers";

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
