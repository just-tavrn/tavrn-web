// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Permission, type RoomDetail, type UserPrivate } from "@tavrn/sdk";
import { applyCompletion, findTrigger } from "./autocomplete";
import { channelCandidates, channelProvider, matchChannels } from "./channels";
import { knownNodes, parseTavrnLink } from "../lib/tavrnLinks";
import { useAuth } from "../stores/auth";

const ROOM = "01J9ZK3G5M8Q2W4E6R8T0Y2RM1";
const id = (n: number) => `01J9ZK3G5M8Q2W4E6R8T0Y2C${String.fromCharCode(65 + n)}${String.fromCharCode(65 + n)}`.slice(0, 26);
const GENERAL = id(0);
const VOICE = id(1);
const FILES = id(2);
const SECRET = id(3);
const FORUM = id(4);
const bits = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();

const room = {
  id: ROOM,
  name: "Raum",
  is_owner: false,
  my_roles: [],
  roles: [{ id: "everyone", name: "@everyone", is_everyone: true, mentionable: false, permissions: bits(Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES, Permission.CONNECT), position: 0, hoist: false, room_id: ROOM }],
  categories: [{ id: "cat1", name: "Text channels", system_name: "general", position: 0, room_id: ROOM, no_bots: false }],
  overrides: [{ target_type: "channel", target_id: SECRET, subject_type: "role", subject_id: "everyone", allow: "0", deny: bits(Permission.VIEW_CHANNEL) }],
  channels: [
    { id: VOICE, name: "Voice", system_name: "voice", kind: "voice", category_id: null, position: 2 },
    { id: GENERAL, name: "general", system_name: "general", kind: "text", category_id: "cat1", position: 0 },
    { id: FILES, name: "ablage-2026", kind: "files", category_id: null, position: 3 },
    { id: SECRET, name: "geheim", kind: "text", category_id: "cat1", position: 1 },
    { id: FORUM, name: "fragen und ideen", kind: "forum", category_id: null, position: 4 },
  ],
} as unknown as RoomDetail;

beforeEach(() => useAuth.setState({ token: "t", user: { id: "u1", username: "me", domain: "localhost", address: "me@localhost" } as unknown as UserPrivate, home: null }));
afterEach(() => useAuth.setState({ token: null, user: null }));

describe("#channel candidates", () => {
  it("are the channels of this room the user can view, in order, with kind, localized names and category", () => {
    const list = channelCandidates({ room, userId: "u1", domain: "localhost" });
    expect(list.map((c) => c.key)).toEqual([GENERAL, VOICE, FILES, FORUM]);
    expect(list[0]).toMatchObject({ name: "allgemein", kind: "text", category: expect.any(String) });
    expect(list[0]!.category).toBeTruthy();
    expect(list[1]).toMatchObject({ name: "Sprache", kind: "voice", category: null });
  });

  it("insert the channel's link, which the link parser recognises as the same channel", () => {
    for (const c of channelCandidates({ room, userId: "u1", domain: "localhost" })) {
      expect(parseTavrnLink(c.insert, knownNodes().nodes)).toEqual({ kind: "channel", node: "localhost", room: ROOM, channel: c.key });
      // Completed in a sentence, the link stands alone (followed by a space).
      const typed = "schau in #all bitte";
      const { value } = applyCompletion(typed, findTrigger(typed, 13, "#")!, c.insert);
      expect(value).toBe(`schau in ${c.insert} bitte`);
    }
  });

  it("match name prefixes (also of words) only, never on an empty query", () => {
    const list = channelCandidates({ room, userId: "u1", domain: "localhost" });
    expect(matchChannels(list, "all").map((c) => c.key)).toEqual([GENERAL]);
    expect(matchChannels(list, "ideen").map((c) => c.key)).toEqual([FORUM]);
    expect(matchChannels(list, "2026").map((c) => c.key)).toEqual([FILES]);
    expect(matchChannels(list, "fragen u").map((c) => c.key)).toEqual([FORUM]);
    // No subsequence matches: `#1` or `#lgm` take nothing over.
    expect(matchChannels(list, "1")).toEqual([]);
    expect(matchChannels(list, "lgm")).toEqual([]);
    expect(matchChannels(list, "")).toEqual([]);
    // A hidden channel is never offered, not even by its exact name.
    expect(matchChannels(list, "geheim")).toEqual([]);
  });

  it("the provider needs one character after # (a heading or a lone # stays text)", () => {
    const provider = channelProvider(channelCandidates({ room, userId: "u1", domain: "localhost" }));
    expect(provider).toMatchObject({ id: "channel", trigger: "#", minQuery: 1 });
    expect(findTrigger("# Titel", 1, "#")).toEqual({ start: 0, end: 1, query: "" });
    expect(findTrigger("# Titel", 2, "#")).toBeNull();
    expect(findTrigger("C#", 2, "#")).toBeNull();
    expect(findTrigger("x.example/#abc", 14, "#")).toBeNull();
    expect(findTrigger("## x", 2, "#")).toBeNull();
    expect(findTrigger("`#all`", 5, "#")).toBeNull();
  });

  it("partial room objects offer what they have", () => {
    expect(channelCandidates({ room: { id: ROOM, channels: [] } as unknown as RoomDetail, userId: "u1", domain: "localhost" })).toEqual([]);
  });
});
