// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { applyMessage, applyRead, applyServer, formatCount, useUnread, type ReadInfo } from "./unread";

const me = { id: "u1", address: "alice@t.local" };
const msg = (id: string, extra: Partial<{ author_id: string; mentions: string[]; mentions_everyone: boolean; conversation_id: string }> = {}) => ({
  id,
  conversation_id: "c1",
  author_id: "u2",
  mentions: [] as string[],
  mentions_everyone: false,
  ...extra,
});

describe("unread counts", () => {
  it("takes the server state from the room and conversation lists", () => {
    const s = applyServer({}, [
      { conversation_id: "c1", last_message_id: "05", last_read_message_id: "03", unread_count: 2, mention_count: 1 },
      { conversation_id: "c2", last_message_id: null, unread_count: 0, mention_count: 0 },
    ]);
    expect(s.c1).toEqual<ReadInfo>({ last: "05", read: "03", unread: 2, mentions: 1 });
    expect(s.c2).toEqual<ReadInfo>({ last: null, read: null, unread: 0, mentions: 0 });
  });

  it("keeps a newer local marker when an older server state arrives (marker still on its way)", () => {
    let s = applyRead({}, "c1", "08");
    s = applyServer(s, [{ conversation_id: "c1", last_message_id: "08", last_read_message_id: "05", unread_count: 1, mention_count: 1 }]);
    expect(s.c1).toEqual<ReadInfo>({ last: "08", read: "08", unread: 0, mentions: 0 });
    s = applyServer(s, [{ conversation_id: "c1", last_message_id: "09", last_read_message_id: "05", unread_count: 2, mention_count: 0 }]);
    expect(s.c1).toEqual<ReadInfo>({ last: "09", read: "08", unread: 2, mentions: 0 });
  });

  it("counts new messages of others, mentions separately, and ignores duplicates and own messages", () => {
    let s = applyServer({}, [{ conversation_id: "c1", last_message_id: "05", last_read_message_id: "05", unread_count: 0, mention_count: 0 }]);
    s = applyMessage(s, msg("06"), me, false);
    s = applyMessage(s, msg("07", { mentions: ["alice@t.local"] }), me, false);
    s = applyMessage(s, msg("08", { mentions_everyone: true }), me, false);
    s = applyMessage(s, msg("08", { mentions_everyone: true }), me, false);
    s = applyMessage(s, msg("04"), me, false);
    expect(s.c1).toMatchObject({ last: "08", unread: 3, mentions: 2 });
    s = applyMessage(s, msg("09", { author_id: "u1" }), me, false);
    expect(s.c1).toMatchObject({ last: "09", unread: 3, mentions: 2 });
    // Unknown conversations start empty.
    s = applyMessage(s, msg("01", { conversation_id: "c9" }), me, false);
    expect(s.c9).toMatchObject({ last: "01", unread: 1, mentions: 0 });
  });

  it("does not count messages of the conversation the user is looking at", () => {
    const s = applyMessage({}, msg("06"), me, true);
    expect(s.c1).toMatchObject({ last: "06", unread: 0, mentions: 0 });
  });

  it("caps at 999 and shows 999+", () => {
    let s = applyServer({}, [{ conversation_id: "c1", last_message_id: "05", unread_count: 999, mention_count: 999 }]);
    s = applyMessage(s, msg("06", { mentions_everyone: true }), me, false);
    expect(s.c1).toMatchObject({ unread: 999, mentions: 999 });
    expect(formatCount(999)).toBe("999+");
    expect(formatCount(12)).toBe("12");
  });

  it("clears on reading the newest message; the marker never moves backwards", () => {
    let s = applyServer({}, [{ conversation_id: "c1", last_message_id: "08", last_read_message_id: "03", unread_count: 4, mention_count: 1 }]);
    s = applyRead(s, "c1", "05");
    expect(s.c1).toMatchObject({ read: "05", unread: 4, mentions: 1 });
    s = applyRead(s, "c1", "08");
    expect(s.c1).toMatchObject({ read: "08", unread: 0, mentions: 0 });
    s = applyRead(s, "c1", "02");
    expect(s.c1?.read).toBe("08");
    expect(applyRead({}, "c7", "01").c7).toEqual<ReadInfo>({ last: "01", read: "01", unread: 0, mentions: 0 });
  });
});

describe("useUnread", () => {
  beforeEach(() => useUnread.setState({ states: {} }));

  it("wires the pure functions to the store", () => {
    useUnread.getState().seed([{ conversation_id: "c1", last_message_id: "05", unread_count: 1, mention_count: 0 }]);
    useUnread.getState().message(msg("06"), me, false);
    expect(useUnread.getState().states.c1).toMatchObject({ unread: 2 });
    useUnread.getState().read("c1", "06");
    expect(useUnread.getState().states.c1).toMatchObject({ unread: 0, read: "06" });
  });
});
