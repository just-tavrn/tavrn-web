// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { ShellEvents } from "./events.ts";

test("events reach the main window on the event channel with the Tauri shell's payloads", () => {
  const sent: unknown[][] = [];
  const events = new ShellEvents(() => ({ send: (...a: unknown[]) => void sent.push(a), isDestroyed: () => false }));
  assert.ok(events.send({ channel: "shell_events", event: { kind: "open", path: "/rooms/1/channels/2" } }));
  assert.ok(events.send({ channel: "shell_events", event: { kind: "tray", action: "deafen" } }));
  assert.ok(events.send({ channel: "hotkeys", event: { action: "push_to_talk", pressed: true } }));
  assert.deepEqual(sent, [
    ["tavrn:events", { channel: "shell_events", event: { kind: "open", path: "/rooms/1/channels/2" } }],
    ["tavrn:events", { channel: "shell_events", event: { kind: "tray", action: "deafen" } }],
    ["tavrn:events", { channel: "hotkeys", event: { action: "push_to_talk", pressed: true } }],
  ]);
});

test("without a window events are dropped", () => {
  assert.equal(new ShellEvents(() => null).send({ channel: "shell_events", event: { kind: "tray", action: "mute" } }), false);
  const gone = new ShellEvents(() => ({ send: () => assert.fail("sent to a destroyed window"), isDestroyed: () => true }));
  assert.equal(gone.send({ channel: "shell_events", event: { kind: "tray", action: "mute" } }), false);
});
