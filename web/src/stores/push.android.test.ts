// SPDX-License-Identifier: Apache-2.0
/** Push in the Android app: UnifiedPush endpoints registered at the node like browser subscriptions (docs/ANDROID.md). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { resetPlatform, setPlatform } from "../platform";
import { androidPlatform, fakeAndroid, type FakeAndroid } from "../platform/androidTestPlatform";
import { endpointRequest, usePush, type PushContext } from "./push";

const KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

function setup(android: FakeAndroid, { enabled = true } = {}) {
  setPlatform(androidPlatform(android));
  const api = {
    push: {
      vapid: vi.fn(async () => ({ enabled, public_key: enabled ? KEY : null })),
      subscribe: vi.fn(async () => ({ id: "sub1" })),
      unsubscribe: vi.fn(async () => undefined),
      test: vi.fn(async () => undefined),
    },
  };
  const ctx: PushContext = { api: api as unknown as PushContext["api"], account: "bob@tavrn.example", homeNode: "tavrn.example", deviceId: "dev1" };
  return { api, ctx };
}

describe("push in the Android app", () => {
  beforeEach(() => {
    localStorage.clear();
    usePush.getState().reset();
  });
  afterEach(() => resetPlatform());

  it("without a distributor says so, and the node's texts reach the native receiver", async () => {
    const android = fakeAndroid({ distributors: [] });
    const { ctx } = setup(android);
    await usePush.getState().init(ctx);
    expect(usePush.getState().status).toBe("no_distributor");
    expect(android.push.configure).toHaveBeenCalledWith(expect.objectContaining({ app: expect.any(String), call_from: expect.any(String) }), "tavrn.example");
  });

  it("is unavailable when the node does not push", async () => {
    const { ctx } = setup(fakeAndroid(), { enabled: false });
    await usePush.getState().init(ctx);
    expect(usePush.getState().status).toBe("unavailable");
  });

  it("asks for the notification permission on the click, then registers the endpoint at the node", async () => {
    const android = fakeAndroid();
    const { api, ctx } = setup(android);
    await usePush.getState().init(ctx);
    expect(usePush.getState().status).toBe("off");
    expect(android.requestPermission).not.toHaveBeenCalled();
    await usePush.getState().enable();
    expect(android.requestPermission).toHaveBeenCalledWith("notifications");
    expect(android.push.register).toHaveBeenCalledWith(KEY);
    expect(api.push.subscribe).toHaveBeenCalledWith({ endpoint: "https://ntfy.example/up1", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) }, device_id: "dev1", expiration_time: null });
    expect(usePush.getState().status).toBe("on");
    // A renewed endpoint goes to the node at once.
    android.emitEndpoint({ endpoint: "https://ntfy.example/new", p256dh: "p", auth: "a" });
    await vi.waitFor(() => expect(api.push.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ endpoint: "https://ntfy.example/new" })));
    // Turned off: the node forgets it and so does the distributor.
    await usePush.getState().disable();
    expect(api.push.unsubscribe).toHaveBeenCalledWith("sub1");
    expect(android.push.unregister).toHaveBeenCalled();
    expect(usePush.getState().status).toBe("off");
  });

  it("a refused permission keeps it off; a blocked one shows the settings", async () => {
    const denied = fakeAndroid({ permission: "denied" });
    let s = setup(denied);
    await usePush.getState().init(s.ctx);
    await usePush.getState().enable();
    expect(usePush.getState().status).toBe("off");
    usePush.getState().reset();
    const blocked = fakeAndroid({ permission: "blocked" });
    s = setup(blocked);
    await usePush.getState().init(s.ctx);
    await usePush.getState().enable();
    expect(usePush.getState().status).toBe("denied");
    expect(blocked.push.register).not.toHaveBeenCalled();
  });

  it("renews an enabled device at start, with a new endpoint when another account had it", async () => {
    const android = fakeAndroid();
    const { api, ctx } = setup(android);
    localStorage.setItem("tavrn.push:bob@tavrn.example", JSON.stringify({ id: "old", key: KEY }));
    api.push.subscribe.mockRejectedValueOnce(new TavrnApiError({ type: "about:blank", title: "Conflict", status: 409, code: "push.endpoint_taken", detail: "" }));
    await usePush.getState().init(ctx);
    expect(usePush.getState().status).toBe("on");
    expect(android.push.unregister).toHaveBeenCalledTimes(1);
    expect(android.push.register).toHaveBeenCalledTimes(2);
    // The distributor dropped it: off, and the node forgets it.
    android.emitUnregistered();
    await vi.waitFor(() => expect(usePush.getState().status).toBe("off"));
  });

  it("builds the node's request from an endpoint", () => {
    expect(endpointRequest({ endpoint: "https://e", p256dh: "p", auth: "a" }, null)).toEqual({ endpoint: "https://e", keys: { p256dh: "p", auth: "a" }, expiration_time: null });
  });
});
