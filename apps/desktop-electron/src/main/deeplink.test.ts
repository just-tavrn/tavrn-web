// SPDX-License-Identifier: Apache-2.0
// The cases of apps/shared-vectors/deeplink.json, which apps/desktop/src-tauri/src/deeplink.rs tests too: both shells
// accept exactly the same links.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLink, linksFromArgs, MAX_PENDING, PendingLinks } from "./deeplink.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../shared-vectors/deeplink.json", import.meta.url), "utf8")) as { accept: Array<[string, string]>; refuse: string[] };

test("the shared vectors of both shells: invites, rooms, add links and the sign-in handoff; everything else refused", () => {
  assert.ok(vectors.accept.length > 0 && vectors.refuse.length > 0);
  for (const [input, link] of vectors.accept) assert.equal(deepLink(input), link, input);
  for (const input of vectors.refuse) assert.equal(deepLink(input), null, input);
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
