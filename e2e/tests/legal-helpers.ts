// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers of the legal specs (design note 4.14): the legal node of the Playwright config (its own node, because published
 * terms change every registration), its admin, registrations that accept the current terms, and the terms dialog.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADULT_DOB, enrollTotp, ensureDateOfBirth, uniqueName, type Account } from "./helpers";

const plus = (port: string, n: number) => String(Number(port) + n);
export const LEGAL_NODE = `http://127.0.0.1:${process.env.E2E_NODE_PORT_LEGAL ?? plus(process.env.E2E_NODE_PORT ?? "8080", 6)}`;
export const LEGAL_WEB = `http://localhost:${process.env.E2E_WEB_PORT_LEGAL ?? plus(process.env.E2E_WEB_PORT ?? "5173", 6)}`;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** The published terms version of the legal node (null without terms). */
export async function termsVersion(request: APIRequestContext): Promise<number | null> {
  const resp = await request.get(`${LEGAL_NODE}/api/v1/legal/pages/terms`);
  return resp.ok() ? ((await resp.json()).version as number) : null;
}

/** Registers on the legal node over the API, accepting the current terms (retries once if they change meanwhile). */
export async function registerOnLegal(request: APIRequestContext, prefix: string, fixed?: string): Promise<Account> {
  const username = fixed ?? uniqueName(prefix);
  const password = `passwort-${username}-xyz`;
  let resp = null;
  for (let i = 0; i < 3; i++) {
    resp = await request.post(`${LEGAL_NODE}/api/v1/auth/register`, { data: { username, password, device_name: "e2e", date_of_birth: ADULT_DOB, accept_terms: await termsVersion(request) } });
    if (resp.status() !== 400) break;
  }
  if (!resp!.ok()) throw new Error(`register: ${resp!.status()} ${await resp!.text()}`);
  const totp = await enrollTotp(request, (await resp!.json()).preauth_token, LEGAL_NODE);
  const s = totp.session!;
  return { username, password, token: s.access_token, refresh: s.refresh_token, userId: s.user.id, isNodeAdmin: !!s.user.is_node_admin, deviceId: s.device_id, totpSecret: totp.secret, recoveryCodes: [...totp.recoveryCodes], lastStep: totp.lastStep };
}

const DIR = resolve(dirname(new URL(import.meta.url).pathname), "../../data-dev/e2e-legal");
const CACHE = resolve(DIR, "legaladmin.json");
const LOCK = resolve(DIR, "legaladmin.lock");

/** The admin of the legal node (`TAVRN_ADMIN_USERS=legaladmin`), cached next to its database like `adminAccount`. */
export async function legalAdmin(request: APIRequestContext): Promise<Account> {
  mkdirSync(DIR, { recursive: true });
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 90_000) rmSync(LOCK, { recursive: true, force: true });
      } catch {
        /* gone meanwhile */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    const cached: Account | null = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
    if (cached) {
      const me = await request.get(`${LEGAL_NODE}/api/v1/users/me/terms`, { headers: auth(cached.token) });
      if (me.ok()) {
        await ensureDateOfBirth(request, cached.token, LEGAL_NODE);
        return cached;
      }
      // An expired access token: refresh it.
      const r = await request.post(`${LEGAL_NODE}/api/v1/auth/refresh`, { data: { refresh_token: cached.refresh } });
      if (r.ok()) {
        const pair = await r.json();
        const next = { ...cached, token: pair.access_token, refresh: pair.refresh_token };
        writeFileSync(CACHE, JSON.stringify(next));
        return next;
      }
    }
    const account = await registerOnLegal(request, "", "legaladmin");
    writeFileSync(CACHE, JSON.stringify(account));
    return account;
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/** Publishes a legal document on the legal node; returns its version. */
export async function publish(request: APIRequestContext, admin: Account, kind: string, markdown: string): Promise<number> {
  const resp = await request.put(`${LEGAL_NODE}/api/v1/admin/legal/documents/${kind}`, { headers: auth(admin.token), data: { markdown, lang: "de" } });
  if (!resp.ok()) throw new Error(`publish ${kind}: ${resp.status()} ${await resp.text()}`);
  return (await resp.json()).version as number;
}

/** Accepts the current terms for an account (keeps the dialog of the other project's new versions away). */
export async function acceptTerms(request: APIRequestContext, account: Account) {
  const version = await termsVersion(request);
  if (version) await request.post(`${LEGAL_NODE}/api/v1/users/me/terms/accept`, { headers: auth(account.token), data: { version } });
}

/** Puts a legal-node session into the browser before the app loads. */
export async function loginOnLegal(page: Page, account: Account) {
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

/** Accepts the terms dialog if a version published by a parallel test shows it. */
export async function acceptTermsDialogIfShown(page: Page) {
  const dialog = page.getByTestId("terms-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByTestId("terms-accept").click();
    await expect(dialog).toHaveCount(0);
  }
}
