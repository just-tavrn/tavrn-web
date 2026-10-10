// SPDX-License-Identifier: Apache-2.0
// node --test apps/desktop/scripts: the SHA-256 files of the release assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChecksums } from "./checksums.mjs";

test("every installer gets <asset>.sha256 in sha256sum format; signatures, feeds, block maps and old sums do not", () => {
  const dir = mkdtempSync(join(tmpdir(), "checksums-"));
  const files = {
    "Tavrn-0.3.0.AppImage": "appimage",
    "tavrn_0.3.0_amd64.deb": "deb",
    "Tavrn_0.3.0_x64-setup.exe": "nsis",
    "Tavrn_0.3.0_x64-setup.exe.sig": "sig",
    "Tavrn_0.3.0_x64_en-US.msi": "msi",
    "Tavrn_0.3.0_x64_en-US.msi.sig": "sig",
    "tavrn-electron_0.3.0_x64-setup.exe": "electron",
    "tavrn-electron_0.3.0_x64-setup.exe.blockmap": "blockmap",
    "latest.json": "{}",
    "latest.yml": "version: 0.3.0",
    "latest.yml.minisig": "sig",
    "latest-linux.yml": "version: 0.3.0",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const written = writeChecksums(dir);
  assert.deepEqual(written, [
    "Tavrn-0.3.0.AppImage.sha256",
    "Tavrn_0.3.0_x64-setup.exe.sha256",
    "Tavrn_0.3.0_x64_en-US.msi.sha256",
    "tavrn-electron_0.3.0_x64-setup.exe.sha256",
    "tavrn_0.3.0_amd64.deb.sha256",
  ]);
  const hex = createHash("sha256").update("deb").digest("hex");
  assert.equal(readFileSync(join(dir, "tavrn_0.3.0_amd64.deb.sha256"), "utf8"), `${hex}  tavrn_0.3.0_amd64.deb\n`, "sha256sum -c reads it");
  // A second run (a re-run of the job) rewrites the same files and never sums a sum.
  assert.deepEqual(writeChecksums(dir), written);
  assert.equal(readdirSync(dir).filter((n) => n.endsWith(".sha256.sha256")).length, 0);
});
