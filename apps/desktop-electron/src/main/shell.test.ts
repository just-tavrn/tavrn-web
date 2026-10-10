// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, loadConfig } from "./config.ts";
import { IpcRegistry, type IpcEventLike } from "./ipc.ts";
import { registerShellHandlers } from "./shell.ts";

const me: IpcEventLike = { sender: "main", senderFrame: { url: "app://tavrn/" } };

function setup(t: { after: (fn: () => void) => void }) {
  const d = mkdtempSync(join(tmpdir(), "tavrn-electron-shell-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const settings = new Settings(join(d, "settings.json"));
  const opened: string[] = [];
  const registry = new IpcRegistry((e) => e === me);
  registerShellHandlers(registry, { settings, version: "0.2.0", openExternal: async (url) => void opened.push(url) });
  const call = (method: string, ...args: unknown[]) => registry.dispatch(`tavrn:shell.${method}`, method, me, args);
  return { settings, opened, call };
}

test("getConfig and setNode work on the settings file", async (t) => {
  const { settings, call } = setup(t);
  assert.deepEqual(await call("getConfig"), { ok: true, value: { node: null, web: null, domain: null } });
  assert.deepEqual(await call("setNode", "http://127.0.0.1:8300/", "http://127.0.0.1:8300", "localhost"), { ok: true, value: "http://127.0.0.1:8300" });
  assert.deepEqual(loadConfig(settings.path), { node: "http://127.0.0.1:8300", web: "http://127.0.0.1:8300", domain: "localhost" });
  assert.deepEqual(await call("getConfig"), { ok: true, value: { node: "http://127.0.0.1:8300", web: "http://127.0.0.1:8300", domain: "localhost" } });
  assert.deepEqual(await call("setNode", "http://evil"), { ok: false, error: "node_url.insecure" });
  assert.deepEqual(await call("setNode", 42), { ok: false, error: "ipc.invalid_arguments" });
});

test("appInfo names the version; this build does not update itself yet", async (t) => {
  const { call } = setup(t);
  assert.deepEqual(await call("appInfo"), { ok: true, value: { version: "0.2.0", updater: false } });
});

test("openExternal hands web links to the system browser and refuses everything else", async (t) => {
  const { opened, call } = setup(t);
  assert.deepEqual(await call("openExternal", "https://example.org/a"), { ok: true, value: undefined });
  assert.deepEqual(await call("openExternal", "mailto:x@example.org"), { ok: true, value: undefined });
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "app://tavrn/", "/relative"]) {
    assert.deepEqual(await call("openExternal", bad), { ok: false, error: "link.refused" }, bad);
  }
  assert.deepEqual(opened, ["https://example.org/a", "mailto:x@example.org"]);
});
