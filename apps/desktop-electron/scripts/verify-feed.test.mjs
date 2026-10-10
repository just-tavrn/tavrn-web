// SPDX-License-Identifier: Apache-2.0
// node --test: the release workflow's check of the signed feeds (verify-feed.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minisignKeyPair } from "../src/main/minisign.fixture.ts";
import { parsePublicKey } from "../src/main/minisign.ts";
import { updateKey, verifyFeedFile } from "./verify-feed.mjs";

const FEED = "version: 0.3.0\nfiles:\n  - url: Tavrn-0.3.0.AppImage\n    sha512: aGVsbG8=\n    size: 5\npath: Tavrn-0.3.0.AppImage\n";

function release(sig) {
  const dir = mkdtempSync(join(tmpdir(), "verify-feed-"));
  writeFileSync(join(dir, "latest-linux.yml"), FEED);
  if (sig !== undefined) writeFileSync(join(dir, "latest-linux.yml.minisig"), sig);
  return join(dir, "latest-linux.yml");
}

test("a feed signed with the update key, for its file name and version, passes", () => {
  const k = minisignKeyPair();
  const pubkey = Buffer.from(k.publicKeyFile).toString("base64");
  assert.equal(verifyFeedFile(release(k.sign(Buffer.from(FEED))), pubkey), "0.3.0");
});

test("refuses another key, another file name or version, and a missing signature", () => {
  const k = minisignKeyPair();
  const pubkey = Buffer.from(k.publicKeyFile).toString("base64");
  assert.throws(() => verifyFeedFile(release(minisignKeyPair().sign(Buffer.from(FEED))), pubkey), /made with key/);
  assert.throws(() => verifyFeedFile(release(k.sign(Buffer.from(FEED), { trustedComment: "timestamp:1\tfile:latest.yml\tversion:0.3.0" })), pubkey), /signed for latest\.yml/);
  assert.throws(() => verifyFeedFile(release(k.sign(Buffer.from(FEED), { trustedComment: "timestamp:1\tfile:latest-linux.yml" })), pubkey), /signed for version \(none\)/);
  assert.throws(() => verifyFeedFile(release(), pubkey), /ENOENT/);
});

test("the update key is tauri.conf.json's and parses", () => {
  assert.equal(parsePublicKey(updateKey()).keyId.length, 8);
});
