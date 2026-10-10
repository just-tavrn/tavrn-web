// SPDX-License-Identifier: Apache-2.0
/**
 * Verification of minisign signatures (https://jedisct1.github.io/minisign/) with Node's own Ed25519, no dependency:
 * the signed update feeds of the Electron shell (`updater.ts`, docs/DESKTOP.md "Updates"). The release workflow signs
 * `latest-linux.yml` and `latest.yml` with the Tauri updater's key (`tauri signer sign`, the same rsign/minisign
 * format), so both shells trust one public key: `plugins.updater.pubkey` of `apps/desktop/src-tauri/tauri.conf.json`.
 *
 * Formats:
 * - public key: the line `base64("Ed" || key id (8 bytes) || Ed25519 public key (32))`, inside a two-line file
 *   (`untrusted comment: …` first); tauri.conf.json carries that file base64-encoded once more. All three forms parse.
 * - signature: `untrusted comment: …`, `base64(algorithm (2) || key id (8) || signature (64))`, `trusted comment: …`,
 *   `base64(global signature (64))`. The algorithm is `ED` (the signature covers BLAKE2b-512 of the file, what rsign and
 *   minisign write by default) or the legacy `Ed` (the file itself). The global signature covers the signature and the
 *   trusted comment, so the comment (timestamp, file name, version) is authentic too.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export interface MinisignPublicKey {
  /** The key id, 8 bytes (minisign prints it little-endian in hex). */
  keyId: Buffer;
  key: KeyObject;
}

export interface MinisignVerified {
  /** The trusted comment, covered by the global signature. */
  trustedComment: string;
  /** The `name:value` fields of the trusted comment, separated by tabs (`timestamp`, `file`, `version`). */
  fields: Record<string, string>;
}

/** Why a signature was refused; the message names the reason (logged by the updater, never shown raw). */
export class MinisignError extends Error {
  override name = "MinisignError";
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UNTRUSTED = "untrusted comment:";
const TRUSTED = "trusted comment: ";

function strictBase64(text: string, what: string): Buffer {
  const t = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 !== 0) throw new MinisignError(`${what} is not base64`);
  return Buffer.from(t, "base64");
}

/** The text of a minisign file given as is or base64-encoded once more (the form of tauri.conf.json and `.sig` files). */
function unwrap(text: string, what: string): string {
  const t = text.trim();
  if (t.startsWith(UNTRUSTED) || !/^[A-Za-z0-9+/=\s]+$/.test(t)) return t;
  const inner = strictBase64(t.replace(/\s+/g, ""), what).toString("utf8").trim();
  return inner.startsWith(UNTRUSTED) ? inner : t;
}

/** Parses a minisign public key: the bare key line, the two-line file, or that file base64-encoded (tauri.conf.json). */
export function parsePublicKey(text: string): MinisignPublicKey {
  const t = unwrap(text, "public key");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines[0]?.startsWith(UNTRUSTED) ? lines[1] : lines[0];
  if (!line || lines.length > 2) throw new MinisignError("public key: not a minisign public key");
  const raw = strictBase64(line, "public key");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new MinisignError("public key: not an Ed25519 minisign key");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]), format: "der", type: "spki" });
  return { keyId: raw.subarray(2, 10), key };
}

/** The key id as minisign prints it (hex, most significant byte first: the 8 bytes reversed). */
export function keyIdHex(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/**
 * Verifies a minisign signature of `data` with `publicKey`: the algorithm, the key id, the signature and the global
 * signature over the trusted comment. Returns the trusted comment; throws `MinisignError` with the reason otherwise.
 */
export function verifyMinisign(data: Uint8Array, signatureText: string, publicKey: MinisignPublicKey): MinisignVerified {
  const lines = unwrap(signatureText, "signature")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""));
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length !== 4 || !lines[0]!.startsWith(UNTRUSTED) || !lines[2]!.startsWith(TRUSTED)) {
    throw new MinisignError("signature: not a minisign signature file");
  }
  const sig = strictBase64(lines[1]!, "signature");
  if (sig.length !== 74) throw new MinisignError("signature: wrong length");
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") throw new MinisignError(`signature: unknown algorithm ${JSON.stringify(algorithm)}`);
  const keyId = sig.subarray(2, 10);
  if (!keyId.equals(publicKey.keyId)) {
    throw new MinisignError(`signature: made with key ${keyIdHex(keyId)}, the app trusts ${keyIdHex(publicKey.keyId)}`);
  }
  const signature = sig.subarray(10);
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!verify(null, message, publicKey.key, signature)) throw new MinisignError("signature: does not match the file");
  const trustedComment = lines[2]!.slice(TRUSTED.length);
  const global = strictBase64(lines[3]!, "global signature");
  if (global.length !== 64 || !verify(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), publicKey.key, global)) {
    throw new MinisignError("signature: the trusted comment is not signed");
  }
  const fields: Record<string, string> = {};
  for (const part of trustedComment.split("\t")) {
    const at = part.indexOf(":");
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  return { trustedComment, fields };
}
