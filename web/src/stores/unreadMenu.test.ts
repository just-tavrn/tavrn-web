// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyUnread, isUnread, markConversationRead, useUnread } from "./unread";

describe("mark unread / mark as read from menus (design note 4.11)", () => {
  beforeEach(() => useUnread.setState({ states: {}, held: {} }));

  it("moves the marker back locally and holds it while the conversation is open", () => {
    useUnread.getState().seed([{ conversation_id: "c1", last_message_id: "m9", last_read_message_id: "m9", unread_count: 0, mention_count: 0 }]);
    useUnread.getState().markUnread("c1", "m4", 3);
    expect(useUnread.getState().states.c1).toMatchObject({ read: "m4", unread: 3, last: "m9" });
    expect(useUnread.getState().held.c1).toBe(true);
    expect(isUnread(useUnread.getState().states, "c1")).toBe(true);
    useUnread.getState().release("c1");
    expect(useUnread.getState().held.c1).toBeUndefined();
    expect(applyUnread({}, "c2", null, 0).c2).toMatchObject({ read: null, unread: 1 });
  });

  it("marks read up to the newest known message on the node", async () => {
    useUnread.getState().seed([{ conversation_id: "c1", last_message_id: "m9", last_read_message_id: "m2", unread_count: 4, mention_count: 1 }]);
    const markRead = vi.fn(async () => ({}));
    expect(await markConversationRead({ conversations: { markRead } }, "c1")).toBe(true);
    expect(markRead).toHaveBeenCalledWith("c1", "m9");
    expect(useUnread.getState().states.c1).toMatchObject({ unread: 0, mentions: 0, read: "m9" });
    expect(await markConversationRead({ conversations: { markRead } }, "unknown")).toBe(false);
  });
});
