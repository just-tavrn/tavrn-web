// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { isChannelNotice } from "./securityNotice";

const msg = (over: Partial<Message> & { device_id?: string | null }) =>
  ({ id: "m1", conversation_id: "c1", encrypted: false, device_id: null, content: { type: "system.bot_added", bot: "echo@x", channel: "c1" }, ...over }) as Message;

describe("security notices in a channel (APPLICATIONS.md §3.6)", () => {
  it("are node-written bot entries about the channel they are in", () => {
    expect(isChannelNotice(msg({}))).toBe(true);
    expect(isChannelNotice(msg({ content: { type: "system.bot_removed", bot: "echo@x", channel: "c1", reason: "left" } }))).toBe(true);
  });

  it("are not welcome channel entries, other system lines, device-signed or encrypted messages", () => {
    // In the welcome channel the entry names another channel.
    expect(isChannelNotice(msg({ conversation_id: "w1" }))).toBe(false);
    expect(isChannelNotice(msg({ content: { type: "system.encryption_changed", encrypted: true, by: "a@x" } }))).toBe(false);
    expect(isChannelNotice(msg({ device_id: "d1" }))).toBe(false);
    expect(isChannelNotice(msg({ encrypted: true, content: "Y2lwaGVy" }))).toBe(false);
    expect(isChannelNotice(msg({ content: { type: "text", body: "system.bot_added", channel: "c1" } }))).toBe(false);
  });
});
