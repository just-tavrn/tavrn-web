// SPDX-License-Identifier: Apache-2.0
// The cases of apps/desktop/src-tauri/src/config.rs and commands.rs (set_node): the settings file has the same schema in
// both shells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_NAME, Settings, importTauriSettings, loadConfig, saveConfig, settingsPath, tauriSettingsPath, type Config } from "./config.ts";

const empty: Config = { node: null, web: null, domain: null };

function dir(t: { after: (fn: () => void) => void }): string {
  const d = mkdtempSync(join(tmpdir(), "tavrn-electron-config-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("the settings file lives in tavrn-desktop/settings.json of the config directory", () => {
  assert.equal(settingsPath("/home/u/.config"), join("/home/u/.config", "tavrn-desktop", "settings.json"));
  assert.equal(FILE_NAME, "settings.json");
});

test("a missing file means no node", (t) => {
  assert.deepEqual(loadConfig(join(dir(t), FILE_NAME)), empty);
});

test("writes and reads the node", (t) => {
  const path = join(dir(t), "nested", FILE_NAME);
  const config: Config = { node: "https://tavrn.example", web: "https://web.tavrn.example", domain: "tavrn.example", close_to_tray: true };
  saveConfig(path, config);
  assert.deepEqual(loadConfig(path), config);
  assert.ok(!existsSync(`${path}.tmp`), "no temporary file is left behind");
  saveConfig(path, empty);
  assert.deepEqual(loadConfig(path), empty);
  // The Tauri shell's serialization: null fields are written, close_to_tray only when chosen.
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { node: null, web: null, domain: null });
});

test("a corrupt file means no node", (t) => {
  const d = dir(t);
  const path = join(d, FILE_NAME);
  for (const text of ["{not json", "", "[]", '{"node": 42}', "null", '"x"', '{"close_to_tray": "yes"}', '{"web": 1, "node": "https://tavrn.example"}']) {
    writeFileSync(path, text);
    assert.deepEqual(loadConfig(path), empty, text);
  }
});

test("a stored node that fails validation is dropped", (t) => {
  const d = dir(t);
  mkdirSync(d, { recursive: true });
  const path = join(d, FILE_NAME);
  writeFileSync(path, '{"node": "http://evil.example"}');
  assert.equal(loadConfig(path).node, null);
  writeFileSync(path, '{"node": "https://Tavrn.Example/", "future": true}');
  assert.equal(loadConfig(path).close_to_tray, undefined, "an older file has no close-to-tray choice");
  assert.equal(loadConfig(path).node, "https://tavrn.example", "normalized; unknown fields ignored");
  writeFileSync(path, '{"node": "https://tavrn.example", "web": "http://evil.example", "domain": "Not A Domain"}');
  const c = loadConfig(path);
  assert.deepEqual([c.web, c.domain], [null, null], "an invalid web origin or domain is dropped");
  writeFileSync(path, '{"node": "https://tavrn-org.example", "web": "https://tavrn.org", "domain": "tavrn-org.example"}');
  const unbound = loadConfig(path);
  assert.deepEqual([unbound.web, unbound.domain], [null, "tavrn-org.example"], "a web origin not bound to the node is dropped");
  writeFileSync(path, '{"web": "https://web.tavrn.example", "domain": "tavrn.example"}');
  assert.deepEqual(loadConfig(path), empty, "nothing without a node");
});

test("setNode validates, normalizes and persists", (t) => {
  const s = new Settings(join(dir(t), FILE_NAME));
  assert.equal(s.setNode("https://Tavrn.Example/"), "https://tavrn.example");
  assert.equal(loadConfig(s.path).node, "https://tavrn.example");
  assert.equal(s.get().node, "https://tavrn.example");
});

test("setNode refuses invalid URLs and keeps the old node", (t) => {
  const s = new Settings(join(dir(t), FILE_NAME));
  s.setNode("https://tavrn.example");
  assert.throws(() => s.setNode("http://evil"), { code: "node_url.insecure" });
  assert.throws(() => s.setNode("https://x.example/path"), { code: "node_url.path" });
  assert.equal(loadConfig(s.path).node, "https://tavrn.example");
});

test("setNode keeps the web origin and the identity domain of a delegated node", (t) => {
  const s = new Settings(join(dir(t), FILE_NAME));
  assert.equal(s.setNode("https://app.tavrn.example", "https://Web.Tavrn.Example/", "Tavrn.Example"), "https://app.tavrn.example");
  const c = loadConfig(s.path);
  assert.deepEqual([c.web, c.domain], ["https://web.tavrn.example", "tavrn.example"]);
  assert.throws(() => s.setNode("https://x.example", "http://evil.example"), { code: "node_url.insecure" });
  assert.throws(() => s.setNode("https://x.example", null, "not a domain"), { code: "node_url.domain" });
  // Another site's origin (and a domain the node merely claims) never becomes the node's web client.
  assert.throws(() => s.setNode("https://tavrn-org.example", "https://tavrn.org", "tavrn-org.example"), { code: "node_url.web_unbound" });
  assert.throws(() => s.setNode("https://evil.example", "https://app.tavrn.org", "tavrn.org"), { code: "node_url.web_unbound" });
  assert.equal(loadConfig(s.path).domain, "tavrn.example", "refusals keep the old settings");
  // The node URL alone (the advanced picker) forgets the old node's details.
  s.setNode("https://other.example");
  assert.deepEqual(loadConfig(s.path), { node: "https://other.example", web: null, domain: null });
});

test("changing one setting keeps the others", (t) => {
  const s = new Settings(join(dir(t), FILE_NAME));
  s.setNode("https://tavrn.example");
  s.update((c) => ({ ...c, close_to_tray: false }));
  s.setNode("https://other.example");
  const stored = loadConfig(s.path);
  assert.equal(stored.node, "https://other.example");
  assert.equal(stored.close_to_tray, false);
});

test("the settings in memory change only when the file was written", (t) => {
  const d = dir(t);
  // The settings path is a directory: writing fails.
  const path = join(d, "blocked");
  mkdirSync(join(path, FILE_NAME), { recursive: true });
  const s = new Settings(join(path, FILE_NAME));
  assert.throws(() => s.setNode("https://tavrn.example"), /config\.write_failed/);
  assert.equal(s.get().node, null);
});

test("switching shells: the Tauri app's home node is taken over once, validated, without its other settings", (t) => {
  const d = dir(t);
  assert.equal(tauriSettingsPath("/home/u/.config"), join("/home/u/.config", "org.tavrn.desktop", "config.json"));
  const ours = settingsPath(d);
  const theirs = tauriSettingsPath(d);
  assert.equal(importTauriSettings(ours, theirs), null, "nothing to take over");
  mkdirSync(join(d, "org.tavrn.desktop"), { recursive: true });
  writeFileSync(theirs, JSON.stringify({ node: "https://App.Home.Example/", web: "https://web.home.example", domain: "home.example", close_to_tray: false }));
  assert.equal(importTauriSettings(ours, theirs), "https://app.home.example");
  assert.deepEqual(loadConfig(ours), { node: "https://app.home.example", web: "https://web.home.example", domain: "home.example" });
  // Once: an existing settings file is never replaced.
  writeFileSync(theirs, JSON.stringify({ node: "https://other.example" }));
  assert.equal(importTauriSettings(ours, theirs), null);
  assert.equal(loadConfig(ours).node, "https://app.home.example");
});

test("switching shells: an invalid or corrupt Tauri settings file imports nothing", (t) => {
  const d = dir(t);
  mkdirSync(join(d, "org.tavrn.desktop"), { recursive: true });
  for (const text of ['{"node": "http://evil.example"}', "{not json", '{"web": "https://web.home.example"}']) {
    writeFileSync(tauriSettingsPath(d), text);
    assert.equal(importTauriSettings(settingsPath(d), tauriSettingsPath(d)), null, text);
    assert.ok(!existsSync(settingsPath(d)), text);
  }
});

test("the update channel is kept only when it is known, like the Tauri shell's config.json", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tavrn-electron-channel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ node: "https://tavrn.example", update_channel: "stable" }));
  assert.equal(loadConfig(path).update_channel, "stable");
  writeFileSync(path, JSON.stringify({ node: "https://tavrn.example", update_channel: "nightly" }));
  assert.equal(loadConfig(path).update_channel, undefined, "an unknown channel is dropped");
  assert.equal(loadConfig(path).node, "https://tavrn.example");
  writeFileSync(path, JSON.stringify({ update_channel: 3 }));
  assert.deepEqual(loadConfig(path), { node: null, web: null, domain: null }, "a wrong type makes the file unreadable, as serde does");
  saveConfig(path, { node: null, web: null, domain: null, update_channel: "beta" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).update_channel, "beta");
  saveConfig(path, { node: null, web: null, domain: null });
  assert.equal("update_channel" in JSON.parse(readFileSync(path, "utf8")), false, "no choice, no field");
});
