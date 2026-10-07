// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MyPresence, Presence, TavrnApi } from "@tavrn/sdk";
import { activeCustom, applyPresence, statusLine, statusOf, usePresence } from "./presence";
import { pushPresence, setAutoIdle, syncPresence } from "../lib/presence";

const p = (user: string, status: string, extra: Partial<Presence> = {}): Presence => ({ user, user_id: user, status, ...extra });
const mine = (status: string, effective = status): MyPresence => ({ status, effective, idle: false, hide_activity: false });

/** A fake node client recording presence calls. */
function client(list: Presence[] = [], me: MyPresence = mine("online")) {
  const calls: unknown[] = [];
  const presence = {
    mine: vi.fn(async () => me),
    set: vi.fn(async (req: unknown) => {
      calls.push(req);
      return { ...me, status: (req as { status?: string }).status ?? me.status };
    }),
    setActivity: vi.fn(async () => me),
    clearActivity: vi.fn(async () => me),
    list: vi.fn(async () => list),
  };
  return { calls, client: { presence } as unknown as TavrnApi, presence };
}

describe("presence store", () => {
  beforeEach(() => usePresence.getState().clear());

  it("keeps presences by address and drops offline users", () => {
    let users = applyPresence({}, p("a@x", "online"));
    users = applyPresence(users, p("b@y", "dnd"));
    expect(Object.keys(users)).toEqual(["a@x", "b@y"]);
    users = applyPresence(users, p("a@x", "offline"));
    expect(Object.keys(users)).toEqual(["b@y"]);
    expect(applyPresence(users, p("z@z", "offline"))).toBe(users);
    expect(statusOf(users, "b@y")).toBe("dnd");
    expect(statusOf(users, "a@x")).toBe("offline");
    expect(statusOf(users, undefined)).toBe("offline");
    // The own account shows the true status (invisible), not what others see.
    expect(statusOf(users, "me@x", { address: "me@x", presence: mine("invisible") })).toBe("invisible");
  });

  it("formats the status line: custom status first, then the activity", () => {
    const label = (a: { name: string }) => `Playing ${a.name}`;
    expect(statusLine({ custom_status: { text: "brb", emoji: "☕" }, activity: { type: "playing", name: "X" } }, label)).toBe("☕ brb");
    expect(statusLine({ custom_status: null, activity: { type: "playing", name: "Factorio" } }, label)).toBe("Playing Factorio");
    expect(statusLine({ custom_status: { text: "old", expires_at: "2000-01-01T00:00:00Z" }, activity: null }, label)).toBeNull();
    expect(activeCustom({ text: "x", expires_at: new Date(Date.now() + 60_000).toISOString() })?.text).toBe("x");
  });

  it("pushes changes to every node, the home node's answer wins", async () => {
    const home = client();
    const other = client();
    await pushPresence({ status: "dnd" }, [home.client, other.client]);
    expect(home.calls).toEqual([{ status: "dnd" }]);
    expect(other.calls).toEqual([{ status: "dnd" }]);
    expect(usePresence.getState().mine?.status).toBe("dnd");
    // A node that fails does not stop the others.
    other.presence.set.mockRejectedValueOnce(new Error("down"));
    await expect(pushPresence({ status: "online" }, [home.client, other.client])).resolves.toBeTruthy();
  });

  it("syncs the home node's state to the other nodes and seeds what they show", async () => {
    const me = { ...mine("dnd"), custom_status: { text: "Raid" }, activity: { type: "playing", name: "X", started_at: "2026-10-05T00:00:00Z" } };
    const home = client([p("friend@home", "online")], me);
    const other = client([p("member@other", "idle")]);
    await syncPresence([home.client, other.client]);
    expect(other.calls).toEqual([{ status: "dnd", custom_status: { text: "Raid" } }]);
    expect(other.presence.setActivity).toHaveBeenCalled();
    const users = usePresence.getState().users;
    expect(Object.keys(users).sort()).toEqual(["friend@home", "member@other"]);
  });

  it("goes idle automatically only when online and comes back", async () => {
    usePresence.getState().setMine(mine("dnd"));
    await setAutoIdle(true);
    expect(usePresence.getState().autoIdle).toBe(false);
    usePresence.getState().setMine(mine("online"));
    const home = client();
    // setAutoIdle uses the real targets; with no sessions only the home client is asked. Route it to the fake.
    const { api } = await import("../lib/api");
    const spy = vi.spyOn(api.presence, "set").mockImplementation(home.presence.set as never);
    await setAutoIdle(true);
    expect(usePresence.getState().autoIdle).toBe(true);
    await setAutoIdle(false);
    expect(home.calls).toEqual([{ status: "idle" }, { status: "online" }]);
    spy.mockRestore();
  });
});
