// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Message } from "@tavrn/sdk";
import { mergeMessageUpdate, type MessageUpdateEvent } from "./reactionEvents";

const VIEWER = { id: "U-ME", address: "me@n.example" };

function msg(reactions: { emoji: string; count: number; me: boolean }[], extra: Partial<Message> = {}): Message {
  return { id: "M1", conversation_id: "C1", author: "a@n.example", author_id: "UA", reactions, ...extra } as unknown as Message;
}

function update(reactions: { emoji: string; count: number; me: boolean }[], reaction?: MessageUpdateEvent["reaction"], extra: Partial<Message> = {}): MessageUpdateEvent {
  return { ...msg(reactions, extra), reaction };
}

describe("mergeMessageUpdate (message.update without per-viewer state)", () => {
  it("keeps the viewer's flags from the cached copy when somebody else reacts", () => {
    const cached = msg([{ emoji: "👍", count: 1, me: true }]);
    const event = update([{ emoji: "👍", count: 2, me: false }, { emoji: "🎉", count: 1, me: false }], { emoji: "🎉", user: "bob@n.example", user_id: "UB", added: true });
    const out = mergeMessageUpdate(cached, event, VIEWER);
    expect(out.reactions).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🎉", count: 1, me: false }]);
    expect("reaction" in out).toBe(false);
  });

  it("never adopts me from an event, even a wrong true", () => {
    const cached = msg([{ emoji: "👍", count: 1, me: false }]);
    const event = update([{ emoji: "👍", count: 2, me: true }], { emoji: "👍", user: "bob@n.example", user_id: "UB", added: true });
    expect(mergeMessageUpdate(cached, event, VIEWER).reactions).toEqual([{ emoji: "👍", count: 2, me: false }]);
  });

  it("sets and clears the flag when the event names the viewer (another tab or device)", () => {
    const cached = msg([{ emoji: "👍", count: 1, me: false }]);
    const added = mergeMessageUpdate(cached, update([{ emoji: "👍", count: 2, me: false }], { emoji: "👍", user: "bob@x", user_id: "U-ME", added: true }), VIEWER);
    expect(added.reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
    const removed = mergeMessageUpdate(added, update([{ emoji: "👍", count: 1, me: false }], { emoji: "👍", user: "Me@N.example", user_id: "OTHER", added: false }), VIEWER);
    expect(removed.reactions).toEqual([{ emoji: "👍", count: 1, me: false }]);
    // The viewer's change of one emoji leaves the flags of the others alone.
    const other = mergeMessageUpdate(msg([{ emoji: "🎉", count: 1, me: true }]), update([{ emoji: "🎉", count: 1, me: false }, { emoji: "👍", count: 1, me: false }], { emoji: "👍", user: "me@n.example", user_id: "U-ME", added: true }), VIEWER);
    expect(other.reactions).toEqual([{ emoji: "🎉", count: 1, me: true }, { emoji: "👍", count: 1, me: true }]);
  });

  it("keeps the flags through edits and pins (no reaction field) and takes the rest of the event", () => {
    const cached = msg([{ emoji: "👍", count: 1, me: true }], { pinned: false });
    const out = mergeMessageUpdate(cached, update([{ emoji: "👍", count: 1, me: false }], undefined, { pinned: true, edited_at: "2026-10-15T10:00:00Z" }), VIEWER);
    expect(out).toMatchObject({ pinned: true, edited_at: "2026-10-15T10:00:00Z", reactions: [{ emoji: "👍", count: 1, me: true }] });
  });

  it("without a cached copy or a viewer every flag is false", () => {
    const event = update([{ emoji: "👍", count: 1, me: true }], { emoji: "👍", user: "me@n.example", user_id: "U-ME", added: true });
    expect(mergeMessageUpdate(undefined, event, null).reactions).toEqual([{ emoji: "👍", count: 1, me: false }]);
    expect(mergeMessageUpdate(undefined, event, VIEWER).reactions).toEqual([{ emoji: "👍", count: 1, me: true }]);
  });

  it("keeps the identity of unchanged reaction entries", () => {
    const event = update([{ emoji: "👍", count: 1, me: false }]);
    const out = mergeMessageUpdate(msg([{ emoji: "👍", count: 1, me: false }]), event, VIEWER);
    expect(out.reactions![0]).toBe(event.reactions![0]);
  });
});
