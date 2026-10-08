// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TavrnApiError, type DeviceInfo } from "@tavrn/sdk";
import { HANDOFF_CODE_TTL_MS, HANDOFF_POLL_MS, signOutAfterHandoff } from "./handoffSignOut";

const device = (id: string, lastSeen: string, current = false): DeviceInfo => ({ id, name: id, client: "c", created_at: "2026-10-08T10:00:00Z", last_seen_at: lastSeen, current, stale: false });
const page = device("PAGE", "2026-10-08T10:00:00Z", true);
const laptop = device("LAPTOP", "2026-10-01T10:00:00Z");

/** `lists` answers the device list polls in turn (the last one repeats); an Error rejects. */
function deps(lists: Array<DeviceInfo[] | Error>) {
  let i = 0;
  const devices = vi.fn(async () => {
    const r = lists[Math.min(i++, lists.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  });
  const signOut = vi.fn(async () => {});
  const sleep = vi.fn(async (_ms: number) => {});
  return { devices, signOut, sleep };
}

describe("the node's page signs itself out after a handoff in the app's sign-in window (#24)", () => {
  it("sign-in: waits until the app exchanged the code (a new device), then signs out", async () => {
    const d = deps([[page, laptop], [page, laptop], [page, laptop, device("APP", "2026-10-08T10:01:00Z")]]);
    await signOutAfterHandoff({ before: [page, laptop], waitForExchange: true, ...d });
    expect(d.devices).toHaveBeenCalledTimes(3);
    expect(d.signOut).toHaveBeenCalledTimes(1);
    expect(d.sleep).toHaveBeenCalledWith(HANDOFF_POLL_MS);
  });

  it("sign-in: the app continued its own device (a device proof): its new login counts as the exchange", async () => {
    const d = deps([[page, laptop], [page, { ...laptop, last_seen_at: "2026-10-08T10:01:00Z" }]]);
    await signOutAfterHandoff({ before: [page, laptop], waitForExchange: true, ...d });
    expect(d.devices).toHaveBeenCalledTimes(2);
    expect(d.signOut).toHaveBeenCalledTimes(1);
  });

  it("sign-in: the page's own refreshes do not count, failed polls are retried", async () => {
    const d = deps([[{ ...page, last_seen_at: "2026-10-08T10:05:00Z" }, laptop], new TypeError("Failed to fetch"), [page, laptop, device("APP", "x")]]);
    await signOutAfterHandoff({ before: [page, laptop], waitForExchange: true, ...d });
    expect(d.devices).toHaveBeenCalledTimes(3);
    expect(d.signOut).toHaveBeenCalledTimes(1);
  });

  it("sign-in: once the code expired it can no longer be exchanged, so the page signs out anyway", async () => {
    const d = deps([[page, laptop]]);
    await signOutAfterHandoff({ before: [page, laptop], waitForExchange: true, ...d });
    expect(d.devices.mock.calls.length).toBe(Math.ceil(HANDOFF_CODE_TTL_MS / HANDOFF_POLL_MS));
    expect(d.signOut).toHaveBeenCalledTimes(1);
  });

  it("sign-in without a device list from before: waits out the code's lifetime", async () => {
    const d = deps([[page, laptop, device("APP", "x")]]);
    await signOutAfterHandoff({ before: null, waitForExchange: true, ...d });
    expect(d.devices).not.toHaveBeenCalled();
    expect(d.sleep).toHaveBeenCalledWith(HANDOFF_CODE_TTL_MS);
    expect(d.signOut).toHaveBeenCalledTimes(1);
  });

  it("unlock: nothing is exchanged with the page's session, it signs out at once", async () => {
    const d = deps([[page]]);
    await signOutAfterHandoff({ before: null, waitForExchange: false, ...d });
    expect(d.devices).not.toHaveBeenCalled();
    expect(d.sleep).not.toHaveBeenCalled();
    expect(d.signOut).toHaveBeenCalledTimes(1);
  });

  it("a page whose session ended meanwhile (revoked elsewhere) stops waiting and cleans up", async () => {
    const d = deps([new TavrnApiError({ type: "x", title: "Unauthorized", status: 401, detail: "", code: "auth.invalid_token" })]);
    await signOutAfterHandoff({ before: [page], waitForExchange: true, ...d });
    expect(d.devices).toHaveBeenCalledTimes(1);
    expect(d.signOut).toHaveBeenCalledTimes(1);
  });
});
