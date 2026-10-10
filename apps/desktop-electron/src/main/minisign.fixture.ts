// SPDX-License-Identifier: Apache-2.0
// Test helpers (not part of the build, tsconfig.build.json): throwaway minisign key pairs and signatures written in
// minisign's formats by the tests themselves, with Node's Ed25519.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { keyIdHex } from "./minisign.ts";

/** A throwaway minisign key pair written in minisign's formats by the test itself. */
export function minisignKeyPair(): { publicKeyFile: string; sign: (data: Uint8Array, opts?: SignOptions) => string; keyId: Buffer; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const keyId = randomBytes(8);
  const publicKeyFile = `untrusted comment: minisign public key: ${keyIdHex(keyId)}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  return { publicKeyFile, keyId, privateKey, sign: (data, opts) => minisignSign(data, privateKey, keyId, opts) };
}

export interface SignOptions {
  algorithm?: "ED" | "Ed";
  trustedComment?: string;
  keyId?: Buffer;
}

export function minisignSign(data: Uint8Array, privateKey: KeyObject, keyId: Buffer, opts: SignOptions = {}): string {
  const algorithm = opts.algorithm ?? "ED";
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  const signature = sign(null, message, privateKey);
  const trusted = opts.trustedComment ?? "timestamp:1791658999\tfile:latest-linux.yml\tversion:0.3.0";
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
  return [
    "untrusted comment: signature from tauri secret key",
    Buffer.concat([Buffer.from(algorithm, "latin1"), opts.keyId ?? keyId, signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    global.toString("base64"),
    "",
  ].join("\n");
}
