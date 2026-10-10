// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import { notesText, registerUpdaterHandlers, updaterConfigured } from "./updater.ts";

const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

test("updates only in a package that carries the feed's settings", (t) => {
  const d = mkdtempSync(join(tmpdir(), "tavrn-electron-updater-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  assert.equal(updaterConfigured(true, d), false);
  writeFileSync(join(d, "app-update.yml"), "provider: github\n");
  assert.equal(updaterConfigured(true, d), true);
  assert.equal(updaterConfigured(false, d), false, "never in a development run");
});

test("release notes become plain text", () => {
  assert.equal(notesText("<p>New <b>things</b> &amp; fixes</p><ul><li>One</li><li>Two</li></ul>"), "New things & fixes\nOne\nTwo");
  assert.equal(notesText([{ note: "<p>A</p>" }, { note: null }, { note: "B" }]), "A\n\nB");
  assert.equal(notesText(null), null);
  assert.equal(notesText(""), null);
});

function fakeUpdater(available: boolean) {
  const calls: string[] = [];
  return {
    calls,
    load: async () => ({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: async () => (calls.push("check"), { isUpdateAvailable: available, updateInfo: { version: "0.3.0", releaseNotes: "<p>New</p>" } }),
      downloadUpdate: async () => void calls.push("download"),
      quitAndInstall: () => void calls.push("install"),
    }),
  };
}

test("checkUpdate and installUpdate as the Tauri commands answer", async () => {
  const off = new IpcRegistry((e) => e === me);
  registerUpdaterHandlers(off, false, fakeUpdater(true).load);
  assert.deepEqual(await off.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: false, error: "update.not_configured" });

  const on = new IpcRegistry((e) => e === me);
  const u = fakeUpdater(true);
  registerUpdaterHandlers(on, true, u.load);
  assert.deepEqual(await on.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: true, value: { version: "0.3.0", notes: "New" } });
  assert.deepEqual(await on.dispatch("tavrn:updater.installUpdate", "installUpdate", me, []), { ok: true, value: undefined });
  assert.deepEqual(u.calls, ["check", "check", "download", "install"]);

  const none = new IpcRegistry((e) => e === me);
  registerUpdaterHandlers(none, true, fakeUpdater(false).load);
  assert.deepEqual(await none.dispatch("tavrn:updater.checkUpdate", "checkUpdate", me, []), { ok: true, value: null });
  assert.deepEqual(await none.dispatch("tavrn:updater.installUpdate", "installUpdate", me, []), { ok: false, error: "update.none" });
});
