// SPDX-License-Identifier: Apache-2.0
// The cases of apps/desktop/src-tauri/src/deeplink.rs: both shells accept exactly the same links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLink, linksFromArgs, MAX_PENDING, PendingLinks } from "./deeplink.ts";

test("invites, rooms and add links name a node", () => {
  assert.equal(deepLink("tavrn://invite/chat.example/AbCd_123"), "tavrn://invite/chat.example/AbCd_123");
  assert.equal(deepLink("TAVRN://Invite/Chat.Example/AbCd_123/"), "tavrn://invite/chat.example/AbCd_123");
  assert.equal(deepLink("tavrn://room/chat.example/01J9ZQ"), "tavrn://room/chat.example/01J9ZQ");
  assert.equal(deepLink("tavrn://room/chat.example/01J9ZQ/01JA00"), "tavrn://room/chat.example/01J9ZQ/01JA00");
  assert.equal(deepLink("tavrn://add/chat.example/01J9ZQ"), "tavrn://add/chat.example/01J9ZQ");
  assert.equal(deepLink("tavrn://add/chat.example/apps.example/01J9ZQ?room=chat.example%2F01AB"), "tavrn://add/chat.example/apps.example/01J9ZQ?room=chat.example%2F01AB");
});

test("the sign-in handoff carries the session and its state only", () => {
  const id = "S".repeat(43);
  const state = "s".repeat(22);
  const ok = `tavrn://connect?session=${id}&state=${state}`;
  assert.equal(deepLink(ok), ok);
  assert.equal(deepLink(`tavrn://connect/?state=${state}&session=${id}`), ok);
  for (const bad of [
    `tavrn://connect?session=${id}`,
    `tavrn://connect?state=${state}`,
    `tavrn://connect?session=${"S".repeat(42)}&state=${state}`,
    `tavrn://connect?session=${id}&state=short`,
    `tavrn://connect?session=${id}&state=${"s".repeat(129)}`,
    `tavrn://connect?session=${id}&state=${state}&code=abcd`,
    `tavrn://connect?session=${id}&session=${id}&state=${state}`,
    `tavrn://connect?session=${id}&state=${state}#k=${id}`,
    `tavrn://connect/x?session=${id}&state=${state}`,
    `tavrn://connect?session=${id}&state=${"+".repeat(22)}`,
  ]) {
    assert.equal(deepLink(bad), null, bad);
  }
});

test("everything else is refused", () => {
  for (const bad of [
    "",
    "not a url",
    "https://chat.example/invite/code1234",
    "tavrn:invite/chat.example/code1234",
    "tavrn://chat.example/invite/code1234",
    "tavrn://invite/chat.example/abc",
    "tavrn://invite/chat.example/code1234/more",
    "tavrn://invite/chat.example/code1234?next=/admin",
    "tavrn://invite/chat.example/code1234#x",
    "tavrn://invite/localhost/code1234",
    "tavrn://invite/127.0.0.1/code1234",
    "tavrn://invite/10.0.0.1/code1234",
    "tavrn://invite/chat.example:8443/code1234",
    "tavrn://invite:1/chat.example/code1234",
    "tavrn://user@invite/chat.example/code1234",
    "tavrn://invite/chat.example/code%2F1234",
    "tavrn://invite/chat.example/../code1234",
    "tavrn://room/chat.example",
    "tavrn://room/chat.example/r1/c1/threads",
    "tavrn://room/chat.example/r1?x=1",
    "tavrn://room/chat.example/r%20 1",
    "tavrn://add/chat.example",
    "tavrn://add/chat.example/not_a_domain/01J9ZQ",
    "tavrn://add/chat.example/01J9ZQ?room=a&room=b",
    "tavrn://add/chat.example/01J9ZQ?room=a%20b",
    "tavrn://add/chat.example/01J9ZQ?other=1",
    "tavrn://settings/chat.example",
    "tavrn://",
    "javascript://invite/chat.example/code1234",
  ]) {
    assert.equal(deepLink(bad), null, bad);
  }
  assert.equal(deepLink(`tavrn://invite/chat.example/${"a".repeat(65)}`), null);
  assert.equal(deepLink(`tavrn://invite/${"a".repeat(500)}.example/code1234`), null);
});

test("links among the arguments of a start, kept until the client takes them", () => {
  const argv = ["/opt/Tavrn/tavrn", "--no-sandbox", "tavrn://invite/chat.example/code1234", "tavrn://invite/localhost/code1234", "https://x.example/"];
  assert.deepEqual(linksFromArgs(argv), ["tavrn://invite/chat.example/code1234"]);
  assert.equal(linksFromArgs(Array(10).fill("tavrn://invite/chat.example/code1234")).length, 4);
  const pending = new PendingLinks();
  assert.equal(pending.add(["/opt/Tavrn/tavrn"]), false);
  assert.equal(pending.add(argv), true);
  for (let i = 0; i < 5; i++) pending.add(Array(4).fill("tavrn://room/chat.example/r1"));
  const taken = pending.take();
  assert.equal(taken.length, MAX_PENDING);
  assert.equal(taken[0], "tavrn://invite/chat.example/code1234");
  assert.deepEqual(pending.take(), []);
});
