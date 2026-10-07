// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TavrnApiError } from "@tavrn/sdk";
import { base64UrlToBytes } from "../lib/push";
import { usePush, type PushContext } from "./push";

const KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const OTHER = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

function fakeSubscription(key: string, endpoint = "https://push.example/sub") {
  return {
    endpoint,
    options: { applicationServerKey: base64UrlToBytes(key).buffer, userVisibleOnly: true },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p256", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function setup({ permission = "default" as NotificationPermission, grant = "granted" as NotificationPermission, existing = null as ReturnType<typeof fakeSubscription> | null, enabled = true } = {}) {
  let current = existing;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (opts: PushSubscriptionOptionsInit) => {
      current = fakeSubscription(btoa(String.fromCharCode(...new Uint8Array(opts.applicationServerKey as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "https://push.example/new");
      return current;
    }),
  };
  const active = { postMessage: vi.fn() };
  const registration = { active, pushManager };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      addEventListener: vi.fn(),
    },
  });
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = grant;
      return grant;
    });
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("PushManager", function PushManager() {});
  const api = {
    push: {
      vapid: vi.fn(async () => ({ enabled, public_key: enabled ? KEY : null })),
      subscriptions: vi.fn(async () => []),
      subscribe: vi.fn(async () => ({ id: "sub1", device_id: "dev1", push_service: "https://push.example", current_device: true, created_at: "", failures: 0 })),
      unsubscribe: vi.fn(async () => undefined),
      test: vi.fn(async () => undefined),
    },
  };
  const ctx: PushContext = { api: api as unknown as PushContext["api"], account: "bob@chat.example.org", homeNode: "chat.example.org", deviceId: "dev1" };
  return { api, ctx, pushManager, active, FakeNotification, current: () => current };
}

describe("push store", () => {
  beforeEach(() => {
    localStorage.clear();
    usePush.getState().reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("is unsupported without a service worker", async () => {
    const { api } = setup();
    Reflect.deleteProperty(navigator, "serviceWorker");
    await usePush.getState().init({ api: api as unknown as PushContext["api"], account: "a", homeNode: "n", deviceId: null });
    expect(usePush.getState().status).toBe("unsupported");
  });

  it("is unavailable when the node does not push, off until enabled, denied when blocked", async () => {
    let s = setup({ enabled: false });
    await usePush.getState().init(s.ctx);
    expect(usePush.getState().status).toBe("unavailable");
    s = setup();
    await usePush.getState().init(s.ctx);
    expect(usePush.getState().status).toBe("off");
    await vi.waitFor(() => expect(s.active.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "tavrn.push.config", homeNode: "chat.example.org" })));
    s = setup({ permission: "denied" });
    await usePush.getState().init(s.ctx);
    expect(usePush.getState().status).toBe("denied");
  });

  it("enables: permission after the click, subscription with the node's key, registration on the node", async () => {
    const s = setup();
    await usePush.getState().init(s.ctx);
    await usePush.getState().enable();
    expect(s.FakeNotification.requestPermission).toHaveBeenCalled();
    expect(s.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(KEY) });
    expect(s.api.push.subscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/new", keys: { p256dh: "p256", auth: "auth" }, device_id: "dev1", expiration_time: null });
    expect(usePush.getState().status).toBe("on");
    expect(JSON.parse(localStorage.getItem("tavrn.push:bob@chat.example.org")!)).toEqual({ id: "sub1", key: KEY });
  });

  it("refused permission leaves push off", async () => {
    const s = setup({ grant: "denied" });
    await usePush.getState().init(s.ctx);
    await usePush.getState().enable();
    expect(s.api.push.subscribe).not.toHaveBeenCalled();
    expect(usePush.getState().status).toBe("denied");
  });

  it("an enabled device renews its registration, and a replaced node key subscribes again", async () => {
    localStorage.setItem("tavrn.push:bob@chat.example.org", JSON.stringify({ id: "old", key: OTHER }));
    const stale = fakeSubscription(OTHER);
    const s = setup({ permission: "granted", existing: stale });
    await usePush.getState().init(s.ctx);
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(s.pushManager.subscribe).toHaveBeenCalled();
    expect(s.api.push.subscribe).toHaveBeenCalledTimes(1);
    expect(usePush.getState().status).toBe("on");
    // Same key: the existing subscription is registered again as it is.
    const same = fakeSubscription(KEY);
    const t = setup({ permission: "granted", existing: same });
    await usePush.getState().init(t.ctx);
    expect(t.pushManager.subscribe).not.toHaveBeenCalled();
    expect(t.api.push.subscribe).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://push.example/sub" }));
  });

  it("disables and signs out: the node's registration and the browser's subscription go", async () => {
    const s = setup();
    await usePush.getState().init(s.ctx);
    await usePush.getState().enable();
    const sub = s.current()!;
    await usePush.getState().disable();
    expect(s.api.push.unsubscribe).toHaveBeenCalledWith("sub1");
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(usePush.getState().status).toBe("off");
    expect(localStorage.getItem("tavrn.push:bob@chat.example.org")).toBeNull();
    // Sign-out tolerates a registration the node already dropped.
    await usePush.getState().enable();
    s.api.push.unsubscribe.mockRejectedValueOnce(new TavrnApiError({ type: "about:blank", title: "Not Found", status: 404, code: "push.subscription_not_found", detail: "" }));
    await usePush.getState().signOut();
    expect(usePush.getState().status).toBe("loading");
  });

  it("the test push reports errors with their code", async () => {
    const s = setup({ permission: "granted" });
    await usePush.getState().init(s.ctx);
    s.api.push.test.mockRejectedValueOnce(new TavrnApiError({ type: "about:blank", title: "Too Many Requests", status: 429, code: "rate_limited", detail: "" }));
    await usePush.getState().test();
    expect(usePush.getState().error).toBe("rate_limited");
  });
});
