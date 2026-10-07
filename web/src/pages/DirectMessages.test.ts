// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Conversation, User } from "@tavrn/sdk";
import { conversationTitle, mergeConversations } from "./DirectMessages";

const u = (address: string, display_name = address.split("@")[0]!): User => ({ id: `id-${address}`, address, display_name, username: address.split("@")[0]!, domain: address.split("@")[1]!, kind: "user" }) as User;
const conv = (id: string, last: string | null, members: User[], extra: Partial<Conversation> = {}): Conversation => ({ id, kind: "dm", encrypted: true, created_at: "", last_message_id: last, members, ...extra });

describe("DM list across nodes", () => {
  it("merges the lists of every node, newest activity first, keeping the hosting node", () => {
    const alice = u("alice@a.test", "Alice");
    const bob = u("bob@b.test", "Bob");
    const carol = u("carol@a.test", "Carol");
    const merged = mergeConversations([
      { node: "a.test", items: [conv("01J0000000000000000000000C", "01J000000000000000000000Z1", [alice, carol])] },
      { node: "b.test", items: [conv("01J0000000000000000000000B", "01J000000000000000000000Z9", [bob, alice]), conv("01J0000000000000000000000D", null, [bob, alice], { kind: "group", name: "Kleeblatt" })] },
      { node: "c.test", items: undefined },
    ]);
    expect(merged.map((c) => `${c.node}/${c.id}`)).toEqual(["b.test/01J0000000000000000000000B", "a.test/01J0000000000000000000000C", "b.test/01J0000000000000000000000D"]);
    // Titles compare addresses: user ids are node-local and differ between nodes.
    expect(conversationTitle(merged[0]!, "alice@a.test")).toBe("Bob");
    expect(conversationTitle(merged[2]!, "alice@a.test")).toBe("Kleeblatt");
  });

  it("lists a conversation once even if a node reports it twice", () => {
    const c = conv("01J0000000000000000000000C", null, []);
    expect(mergeConversations([{ node: "a.test", items: [c, c] }])).toHaveLength(1);
  });
});
