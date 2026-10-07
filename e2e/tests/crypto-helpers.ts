// SPDX-License-Identifier: Apache-2.0
// Accounts whose encryption runs in the test process (the real WebAssembly crypto in Node.js): they
// let a spec set up situations around a browser user, e.g. a leftover device in a group. They drive a
// raw MLS client on purpose (no session manager): the specs need devices that misbehave or lag behind.
import { Client, MasterSecret } from "@tavrn/crypto";
import { ensureCrypto } from "@tavrn/e2ee";
import type { APIRequestContext } from "@playwright/test";
import { NODE, registerViaApi, type Account } from "./helpers";

const DOMAIN = "localhost";
export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export interface CryptoAccount extends Account {
  address: string;
  master: MasterSecret;
  client: Client;
}

async function call(request: APIRequestContext, method: "get" | "post" | "put", path: string, token: string, data?: unknown) {
  const resp = await request[method](`${NODE}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` }, data });
  if (!resp.ok()) throw new Error(`${method} ${path}: ${resp.status()} ${await resp.text()}`);
  return resp.status() === 204 ? null : resp.json();
}

/** Account over the API with identity key and one attested device whose MLS client lives in the test. */
export async function cryptoAccountViaApi(request: APIRequestContext, prefix: string): Promise<CryptoAccount> {
  await ensureCrypto();
  const account = await registerViaApi(request, prefix);
  const address = `${account.username}@${DOMAIN}`;
  const master = MasterSecret.generate();
  await call(request, "put", "/users/me/identity", account.token, { identity_public_key: b64url(master.identityPublicKey()) });
  const client = Client.create(address, account.deviceId);
  const signature = master.attestDevice(address, account.deviceId, client.devicePublicKey);
  await call(request, "put", `/users/me/devices/${account.deviceId}/key`, account.token, { device_public_key: b64url(client.devicePublicKey), identity_signature: b64url(signature) });
  return { ...account, address, master, client };
}

/** Creates the MLS group of a conversation with this device as the only member. */
export async function createGroup(request: APIRequestContext, account: CryptoAccount, conversationId: string) {
  const groupInfo = account.client.createGroup(`${DOMAIN}/${conversationId}`);
  await call(request, "post", `/conversations/${conversationId}/mls/group`, account.token, { group_info: b64url(groupInfo) });
}

/** Joins a conversation's group by external commit (ENCRYPTION.md §4.2). */
export async function externalJoin(request: APIRequestContext, account: CryptoAccount, conversationId: string) {
  const conversation = `${DOMAIN}/${conversationId}`;
  const info = await call(request, "get", `/conversations/${conversationId}/mls/group-info`, account.token);
  const out = account.client.joinByExternalCommit(conversation, unb64url(info.group_info));
  await call(request, "post", `/conversations/${conversationId}/mls/commits`, account.token, { epoch: out.epoch, commit: b64url(out.commit), group_info: b64url(out.groupInfo), welcome: null });
  account.client.mergePendingCommit(conversation);
}

/** Sends an encrypted text message from this device (current epoch). */
export async function sendEncrypted(request: APIRequestContext, account: CryptoAccount, conversationId: string, body: string) {
  const conversation = `${DOMAIN}/${conversationId}`;
  const content = account.client.encryptContent(conversation, JSON.stringify({ type: "text", body }));
  await call(request, "post", `/conversations/${conversationId}/messages`, account.token, { content, epoch: account.client.currentEpoch(conversation) });
}

/** A fresh Ed25519 identity key (base64url) for an identity reset over the API. */
export async function freshIdentityKey(): Promise<string> {
  await ensureCrypto();
  const master = MasterSecret.generate();
  try {
    return b64url(master.identityPublicKey());
  } finally {
    master.free();
  }
}
