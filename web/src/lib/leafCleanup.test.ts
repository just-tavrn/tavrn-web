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

const fake = vi.hoisted(() => ({
  roster: [] as string[],
  /** Leaves of deleted devices (any member removes them). */
  unattested: [] as string[],
  pending: [] as Array<{ identity: string; reason: string }>,
  removed: [] as string[][],
  pendingCalls: 0,
  /** One session manager per test: the cleaner (single flight, election wait) belongs to it. */
  mls: null as unknown,
}));
function makeMls() {
  return {
    identity: "alice@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VA2",
    address: "alice@t.local",
    hasGroup: () => true,
    roster: () => [...fake.roster],
    ghostCheck: async (_q: string, members: Iterable<string>) => {
      const allowed = new Set(members);
      return fake.roster
        .filter((i) => fake.unattested.includes(i) || !allowed.has(i.split("/")[0]!))
        .map((identity) => ({ identity, reason: fake.unattested.includes(identity) ? "unattested" : "not_member", key: "a2V5" }));
    },
    removeLeaves: async (_q: string, ids: string[]) => {
      fake.removed.push(ids);
      fake.roster = fake.roster.filter((i) => !ids.includes(i));
      return true;
    },
  };
}
vi.mock("../stores/mls", () => ({ getMls: async () => fake.mls }));
vi.mock("../stores/nodes", () => ({
  apiFor: () => ({
    mls: {
      pendingRemovals: async () => {
        fake.pendingCalls++;
        return { items: fake.pending };
      },
    },
  }),
}));

const { cleanupBeforeVoice, cleanupConversation, isGhostRefusal, withDepartedLeavesGone } = await import("./leafCleanup");
const { usePresence } = await import("../stores/presence");

beforeEach(() => {
  fake.roster = [bob, me, carol];
  fake.unattested = [];
  fake.pending = [{ identity: carol, reason: "not_member" }];
  fake.removed = [];
  fake.pendingCalls = 0;
  fake.mls = makeMls();
  usePresence.getState().clear();
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

describe("the cleanup of a voice join never waits for the election (ENCRYPTION.md §4.7)", () => {
  it("a join while a background cleanup waits for the election goes on at once and the cleanup still lands", async () => {
    vi.useFakeTimers();
    try {
      // mls.remove_needed: Bob (lower device id) is elected, this device waits ten seconds.
      const background = cleanupConversation(Q, { mayManage: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.removed).toEqual([]);
      let joined = false;
      const join = cleanupBeforeVoice(Q, { online: () => [] }).then((after) => {
        joined = true;
        return after;
      });
      // No timer needs to fire: the join's cleanup ended the election wait of the running one.
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(joined).toBe(true));
      expect((await background)?.outcome).toBe("removed");
      expect(fake.removed).toEqual([[carol]]);
      // Nothing was postponed: no second cleanup.
      (await join)();
      expect(fake.removed).toEqual([[carol]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("another device is elected: the join goes on at once, the cleanup runs in the background once connected", async () => {
    vi.useFakeTimers();
    try {
      const deleted = "dave@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD9";
      fake.roster = [bob, me, deleted];
      fake.unattested = [deleted];
      fake.pending = [{ identity: deleted, reason: "deleted" }];
      // Bob is in the channel and has the lower device id.
      const after = await cleanupBeforeVoice(Q, { online: () => [bob] });
      expect(fake.removed).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      after();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(fake.removed).toEqual([[deleted]]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the pending removals of a voice join", () => {
  it("come from the request started beforehand (in parallel with the group join): no second request", async () => {
    const deleted = "dave@t.local/01J9ZK3G5M8Q2W4E6R8T0Y2VD9";
    fake.roster = [me, deleted];
    fake.unattested = [deleted];
    const after = await cleanupBeforeVoice(Q, { online: () => [], pending: Promise.resolve([{ identity: deleted, reason: "deleted" }]) });
    after();
    expect(fake.removed).toEqual([[deleted]]);
    // Only the refresh after the removal (for the warning's labels).
    expect(fake.pendingCalls).toBe(1);
  });
});

describe("the election of a background cleanup counts only devices that may do it and are online", () => {
  it("a lower device id of a user the presence lists show offline: this device removes at once", async () => {
    vi.useFakeTimers();
    try {
      usePresence.getState().seed([{ user: "carol@t.local", status: "online" } as never]);
      const r = await cleanupConversation(Q, { mayManage: true });
      expect(r?.outcome).toBe("removed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lower device id of a member who may not remove departed members: this device removes at once", async () => {
    vi.useFakeTimers();
    try {
      const r = await cleanupConversation(Q, { mayManage: true, managers: ["alice@t.local"] });
      expect(r?.outcome).toBe("removed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("before the presence lists are loaded, and with Bob online and allowed, the election waits as before", async () => {
    vi.useFakeTimers();
    try {
      const first = cleanupConversation(Q, { mayManage: true, managers: ["alice@t.local", "bob@t.local"] });
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.removed).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await first)?.outcome).toBe("removed");
      fake.roster = [bob, me, carol];
      usePresence.getState().seed([{ user: "bob@t.local", status: "online" } as never]);
      const second = cleanupConversation(Q, { mayManage: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(fake.removed).toEqual([[carol]]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await second)?.outcome).toBe("removed");
    } finally {
      vi.useRealTimers();
    }
  });
});
