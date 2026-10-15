// SPDX-License-Identifier: Apache-2.0
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@tavrn/sdk";

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../lib/mentionBadges", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/mentionBadges")>();
  return {
    ...real,
    mentionTokens: (...args: Parameters<typeof real.mentionTokens>) => {
      calls.n++;
      return real.mentionTokens(...args);
    },
  };
});

const { MessageList } = await import("./MessageList");

const msg = (i: number): Message => ({ id: `m${String(i).padStart(3, "0")}`, conversation_id: "c1", author: "alice@t.local", author_id: "u1", device_id: "d1", encrypted: false, format: 1, epoch: null, content: { type: "text", body: `hi @bob ${i}` }, reply_to_id: null, thread_id: null, mentions: ["bob@t.local"], mentions_everyone: false, created_at: new Date().toISOString(), edited_at: null, attachments: [], reactions: [], pinned: false }) as Message;

describe("MessageList: mention tokens", () => {
  it("builds a row's mention tokens once per message, not on every list render", () => {
    const bots = new Set(["weather@t.local"]);
    const roles = ["Mod"];
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    const { rerender } = render(<MessageList messages={messages} currentUserId="u9" currentAddress="me@t.local" bots={bots} mentionRoles={roles} canManage={false} hasMore={false} />);
    const first = calls.n;
    expect(first).toBe(30);
    for (let i = 0; i < 3; i++) rerender(<MessageList messages={[...messages]} currentUserId="u9" currentAddress="me@t.local" bots={bots} mentionRoles={roles} canManage={false} hasMore={false} />);
    expect(calls.n).toBe(first);
  });
});
