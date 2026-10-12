// SPDX-License-Identifier: Apache-2.0
/**
 * A message after a member left (issue #86): while the departed member's leaf is still in the group the session
 * manager refuses to encrypt (`MlsError("ghost")`, ENCRYPTION.md §4.6). The send removes the leaf at once (no election
 * wait, §4.7) and encrypts once more; a refusal the removal cannot settle stands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MlsError } from "@tavrn/e2ee";

const Q = "t.local/01J9ZK3G5M8Q2W4E6R8T0Y2V00";
const me = "alice@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VA2";
// Bob's device id is lower: he is elected, this device would wait ten seconds before removing the leaf itself.
const bob = "bob@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const carol = "carol@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VC1";

const fake = vi.hoisted(() => ({ roster: [] as string[], pending: [] as Array<{ identity: string; reason: string }>, removed: [] as string[][] }));
vi.mock("../stores/mls", () => ({
  getMls: async () => ({
    identity: "alice@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VA2",
    address: "alice@t.local",
    hasGroup: () => true,
    roster: () => [...fake.roster],
    ghostCheck: async (_q: string, members: Iterable<string>) => {
      const allowed = new Set(members);
      return fake.roster.filter((i) => !allowed.has(i.split("/")[0]!)).map((identity) => ({ identity, reason: "not_member", key: "a2V5" }));
    },
    removeLeaves: async (_q: string, ids: string[]) => {
      fake.removed.push(ids);
      fake.roster = fake.roster.filter((i) => !ids.includes(i));
      return true;
    },
  }),
}));
vi.mock("../stores/nodes", () => ({ apiFor: () => ({ mls: { pendingRemovals: async () => ({ items: fake.pending }) } }) }));

const { isGhostRefusal, withDepartedLeavesGone } = await import("./leafCleanup");

beforeEach(() => {
  fake.roster = [bob, me, carol];
  fake.pending = [{ identity: carol, reason: "not_member" }];
  fake.removed = [];
});

/** An encryption the ghost check refuses while Carol's leaf is in the group. */
const encrypt = vi.fn(async () => {
  if (fake.roster.includes(carol)) throw new MlsError("ghost");
  return { content: "ciphertext", epoch: 2 };
});

describe("the first message after a member left", () => {
  it("removes the departed member's leaf at once (no election wait) and encrypts again", async () => {
    vi.useFakeTimers();
    try {
      const sent = await withDepartedLeavesGone(Q, { members: ["alice@t.local", "bob@t.local"], mayManage: true }, encrypt);
      expect(sent).toEqual({ content: "ciphertext", epoch: 2 });
      expect(fake.removed).toEqual([[carol]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the refusal stands when the leaf may not be removed by this user", async () => {
    await expect(withDepartedLeavesGone(Q, { members: ["alice@t.local", "bob@t.local"], mayManage: false }, encrypt)).rejects.toSatisfy(isGhostRefusal);
    expect(fake.removed).toEqual([]);
  });

  it("other errors are not retried", async () => {
    const failing = vi.fn(async () => {
      throw new MlsError("catch_up_failed");
    });
    await expect(withDepartedLeavesGone(Q, { members: ["alice@t.local", "bob@t.local"], mayManage: true }, failing)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(fake.removed).toEqual([]);
  });
});
