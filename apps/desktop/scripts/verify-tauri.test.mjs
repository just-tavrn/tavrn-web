// SPDX-License-Identifier: Apache-2.0
// node --test: the release workflow's check of the Tauri updater signatures (verify-tauri.mjs), including a round trip
// through the real `tauri signer` of the lockfile, the signer release-assets uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { minisignKeyPair } from "../../desktop-electron/src/main/minisign.fixture.ts";
import { parsePublicKey } from "../../desktop-electron/src/main/minisign.ts";
import { latestJson } from "./latest-json.mjs";
import { tauriInstallers, updateKey, verifyRelease } from "./verify-tauri.mjs";

const MSI = "tavrn_0.3.0_x64_en-US.msi";
const NSIS = "tavrn_0.3.0_x64-setup.exe";
const TAURI = fileURLToPath(new URL("../node_modules/.bin/tauri", import.meta.url));

/** A release directory with both installers, each signed by `sign(name, bytes)` unless it returns undefined. */
function release(sign) {
  const dir = mkdtempSync(join(tmpdir(), "verify-tauri-"));
  for (const name of [MSI, NSIS, "tavrn-electron_0.3.0_x64-setup.exe"]) {
    const bytes = Buffer.from(`installer ${name}`);
    writeFileSync(join(dir, name), bytes);
    if (/electron/.test(name)) continue;
    const sig = sign(name, bytes);
    if (sig !== undefined) writeFileSync(join(dir, `${name}.sig`), Buffer.from(sig).toString("base64"));
  }
  return dir;
}

function fixtureKey() {
  const k = minisignKeyPair();
  const sign = (name, bytes) => k.sign(bytes, { trustedComment: `timestamp:1791658999\tfile:${name}` });
  return { k, sign, pubkey: Buffer.from(k.publicKeyFile).toString("base64") };
}

function withManifest(dir) {
  const json = latestJson({ dir, tag: "v0.3.0", repo: "just-tavrn/tavrn-web" });
  writeFileSync(join(dir, "latest.json"), JSON.stringify(json));
  return json;
}

test("installers signed with the update key for their file names pass, with latest.json", () => {
  const { sign, pubkey } = fixtureKey();
  const dir = release(sign);
  withManifest(dir);
  assert.deepEqual(verifyRelease(dir, pubkey), [NSIS, MSI].sort());
  assert.deepEqual(tauriInstallers(dir), [NSIS, MSI].sort());
});

test("the real tauri signer writes signatures the check accepts (the updater's format)", () => {
  const dir = release(() => undefined);
  const keyFile = join(dir, "update.key");
  const gen = spawnSync(TAURI, ["signer", "generate", "--ci", "-p", "test", "-w", keyFile], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test" };
  for (const name of [MSI, NSIS]) {
    const run = spawnSync(TAURI, ["signer", "sign", join(dir, name)], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
  }
  withManifest(dir);
  const pubkey = readFileSync(`${keyFile}.pub`, "utf8");
  assert.deepEqual(verifyRelease(dir, pubkey), [NSIS, MSI].sort());
  assert.throws(() => verifyRelease(dir, fixtureKey().pubkey), /made with key/);
});

test("refuses another key, a changed installer, a missing signature and a signature for another file", () => {
  const { k, sign, pubkey } = fixtureKey();
  assert.throws(() => verifyRelease(release(fixtureKey().sign), pubkey), /made with key/);
  const changed = release(sign);
  writeFileSync(join(changed, MSI), "something else");
  assert.throws(() => verifyRelease(changed, pubkey), /signature/i);
  assert.throws(() => verifyRelease(release((name, bytes) => (name === NSIS ? undefined : sign(name, bytes))), pubkey), /no signature/);
  const swapped = release((name, bytes) => k.sign(bytes, { trustedComment: `timestamp:1\tfile:${name === MSI ? NSIS : MSI}` }));
  assert.throws(() => verifyRelease(swapped, pubkey), /signed for/);
});

test("refuses a latest.json whose signature or URL does not match the signed installers", () => {
  const { sign, pubkey } = fixtureKey();
  const dir = release(sign);
  const json = withManifest(dir);
  const msiSig = json.platforms["windows-x86_64-msi"].signature;
  json.platforms["windows-x86_64-nsis"].signature = msiSig;
  writeFileSync(join(dir, "latest.json"), JSON.stringify(json));
  assert.throws(() => verifyRelease(dir, pubkey), /not the signature of/);
  json.platforms["windows-x86_64-nsis"] = { signature: msiSig, url: "https://github.com/just-tavrn/tavrn-web/releases/download/v0.3.0/other.exe" };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(json));
  assert.throws(() => verifyRelease(dir, pubkey), /not a signed installer/);
});

test("the update key is tauri.conf.json's and parses", () => {
  assert.equal(parsePublicKey(updateKey()).keyId.length, 8);
});
