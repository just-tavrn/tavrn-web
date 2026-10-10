// SPDX-License-Identifier: Apache-2.0
/** The test node's API for the smoke test: an account with TOTP registered like another device of the user would. */
import { createHmac, randomBytes } from "node:crypto";
import { nodeUrl } from "./harness.ts";

export async function api<T = unknown>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const resp = await fetch(`${nodeUrl}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => null)) as T;
  if (!resp.ok) throw new Error(`${method} ${path}: ${resp.status} ${JSON.stringify(json)}`);
  return json;
}

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export interface Account {
  username: string;
  password: string;
  /** A session of the registering device (to read the account's devices). */
  token: string;
  secret: string;
  lastStep: number;
}

/** A code newer than the last accepted one (the node refuses replays), within the node's window. */
export async function nextCode(account: Account): Promise<string> {
  const now = () => Math.floor(Date.now() / 30_000);
  while (account.lastStep + 1 > now() + 1) await new Promise((r) => setTimeout(r, 1000));
  account.lastStep = Math.max(now(), account.lastStep + 1);
  return totp(account.secret, account.lastStep);
}

/** A new account with TOTP, registered over the API. */
export async function registerAccount(): Promise<Account> {
  const username = `el${randomBytes(4).toString("hex")}`;
  const password = `passwort-${username}-xyz`;
  const pre = await api<{ preauth_token: string }>("POST", "/auth/register", { username, password, device_name: "smoke", date_of_birth: "1990-01-01" });
  const { secret } = await api<{ secret: string }>("POST", "/auth/totp/enroll", {}, pre.preauth_token);
  const account: Account = { username, password, token: "", secret, lastStep: 0 };
  const confirmed = await api<{ session: { access_token: string } }>("POST", "/auth/totp/confirm", { code: await nextCode(account) }, pre.preauth_token);
  account.token = confirmed.session.access_token;
  return account;
}

/** The account's devices (name per device). */
export async function devices(account: Account): Promise<Array<{ name: string }>> {
  return api("GET", "/users/me/devices", undefined, account.token);
}
