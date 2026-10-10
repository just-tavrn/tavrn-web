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
  const windows: string[] = [];
  const registry = new IpcRegistry((e) => e === me);
  registerShellHandlers(registry, {
    settings,
    version: "0.2.0",
    updater: false,
    openExternal: async (url) => void opened.push(url),
    resolve: async (domain) => {
      if (domain === "nowhere.example") throw { code: "resolve.not_found", step: "direct", domain };
      return { domain, api: `https://${domain}/api/v1`, ws: `wss://${domain}/api/v1/ws`, web: `https://${domain}`, source: "well_known" };
    },
    connect: { open: async (url) => void windows.push(url), close: () => void windows.push("closed") },
  });
  const call = (method: string, ...args: unknown[]) => registry.dispatch(`tavrn:shell.${method}`, method, me, args);
  return { settings, opened, windows, call };
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

test("resolveNode answers the node or the resolve failure as an object", async (t) => {
  const { call } = setup(t);
  assert.deepEqual(await call("resolveNode", "home.example"), { ok: true, value: { domain: "home.example", api: "https://home.example/api/v1", ws: "wss://home.example/api/v1/ws", web: "https://home.example", source: "well_known" } });
  assert.deepEqual(await call("resolveNode", "nowhere.example"), { ok: false, error: { code: "resolve.not_found", step: "direct", domain: "nowhere.example" } });
});

test("openConnect shows only the chosen node's sign-in page; closeConnect closes it", async (t) => {
  const { settings, windows, call } = setup(t);
  const page = `https://web.home.example/connect?session=${"S".repeat(43)}`;
  assert.deepEqual(await call("openConnect", page), { ok: false, error: "connect.no_node" });
  settings.setNode("https://app.home.example", "https://web.home.example", "home.example");
  assert.deepEqual(await call("openConnect", page), { ok: true, value: undefined });
  assert.deepEqual(await call("openConnect", `https://app.home.example/connect?session=${"S".repeat(43)}`), { ok: false, error: "connect.url_refused: other_origin" });
  assert.deepEqual(await call("openConnect", "https://web.home.example/login"), { ok: false, error: "connect.url_refused: invalid" });
  assert.deepEqual(await call("closeConnect"), { ok: true, value: undefined });
  assert.deepEqual(windows, [page, "closed"]);
});
