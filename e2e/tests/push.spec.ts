// SPDX-License-Identifier: Apache-2.0
/**
 * Web push (tavrn-protocol PROTOCOL.md §6d). Browsers in the test run have no real push service, so the page's
 * `PushManager` is replaced (init script) by one that hands out a subscription to a fake push service run by this
 * spec. The spec checks the settings flow, that the node stored the subscription, that the node pushes to it (test
 * push, and a message while the user has no open tab), and that disabling and signing out remove it.
 */
import { createECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { NODE, createRoomViaApi, loginAs, loginViaApi, logoutViaUi, openNavIfMobile, registerViaApi, type Account } from "./helpers";
import { joinRoom, postMessage } from "./menu-helpers";

const b64url = (b: Buffer) => b.toString("base64url");

/** A push service on 127.0.0.1 that records the paths it was posted to. */
async function fakePushService(): Promise<{ server: Server; origin: string; received: string[] }> {
  const received: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received.push(req.url ?? "");
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/**
 * Replaces the browser's PushManager by one that subscribes to `endpoint` with valid RFC 8291 keys, and the
 * notification permission prompt by one that grants.
 */
async function mockPushManager(page: Page, endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
  await page.addInitScript(
    ({ endpoint, keys }) => {
      const KEY = "e2e.push.subscription";
      const make = (serverKey: ArrayBuffer | null) => ({
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: serverKey },
        toJSON: () => ({ endpoint, expirationTime: null, keys }),
        getKey: () => null,
        unsubscribe: async () => {
          localStorage.removeItem(KEY);
          return true;
        },
      });
      const stored = () => {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
        return make(bytes.buffer);
      };
      PushManager.prototype.getSubscription = async function () {
        return stored() as unknown as PushSubscription;
      };
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const key = options?.applicationServerKey as Uint8Array;
        localStorage.setItem(KEY, btoa(String.fromCharCode(...key)));
        return stored() as unknown as PushSubscription;
      };
      PushManager.prototype.permissionState = async function () {
        return "granted";
      };
      // Headless Chromium reports notifications as denied whatever was granted: the permission prompt is mocked too
      // (it grants on the first request, as a user would).
      let permission: NotificationPermission = localStorage.getItem("e2e.push.permission") === "granted" ? "granted" : "default";
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
      Notification.requestPermission = async () => {
        permission = "granted";
        localStorage.setItem("e2e.push.permission", "granted");
        return permission;
      };
    },
    { endpoint, keys },
  );
}

async function subscriptions(request: APIRequestContext, token: string) {
  const resp = await request.get(`${NODE}/api/v1/users/me/push-subscriptions`, { headers: { Authorization: `Bearer ${token}` } });
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as Array<{ id: string; push_service: string; current_device: boolean }>;
}

test.describe("Web push", () => {
  test("enable on this device, test push, a push while no tab is open, disable and sign-out", async ({ browser, request }, testInfo) => {
    const service = await fakePushService();
    try {
      const alice = await registerViaApi(request, "alice");
      const bob = await registerViaApi(request, "bob");
      const room = await createRoomViaApi(request, alice.token, "Push-Raum");
      await joinRoom(request, alice, room.id, bob);
      const channelId = room.channels.find((c: { kind: string }) => c.kind === "text").id as string;

      const context = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
      await context.grantPermissions(["notifications"], { origin: new URL(String(testInfo.project.use.baseURL)).origin });
      const page = await context.newPage();
      const endpoint = `${service.origin}/push/${bob.username}`;
      await mockPushManager(page, endpoint);
      await loginAs(page, bob);
      await page.goto("/settings/notifications");

      const push = page.getByTestId("push-settings");
      await expect(push).toHaveAttribute("data-status", "off");
      await page.getByTestId("push-enable").click();
      await expect(push).toHaveAttribute("data-status", "on");
      // The node stored the subscription of this device.
      await expect.poll(async () => (await subscriptions(request, bob.token)).map((s) => [s.push_service, s.current_device])).toEqual([[service.origin, true]]);

      // The preview switch is a notification setting on the node.
      await page.getByTestId("push-text").check();
      await expect
        .poll(async () => {
          const r = await request.get(`${NODE}/api/v1/users/me/notification-settings`, { headers: { Authorization: `Bearer ${bob.token}` } });
          return ((await r.json()) as { global: { push_text?: boolean } }).global.push_text;
        })
        .toBe(true);

      // The test push reaches the push service even while the tab is open.
      await page.getByTestId("push-test").click();
      await expect.poll(() => service.received.filter((p) => p === `/push/${bob.username}`).length).toBe(1);

      // Disable and enable again: the node's registration goes and comes back.
      await page.getByTestId("push-enable").click();
      await expect(push).toHaveAttribute("data-status", "off");
      await expect.poll(async () => (await subscriptions(request, bob.token)).length).toBe(0);
      await page.getByTestId("push-enable").click();
      await expect(push).toHaveAttribute("data-status", "on");
      await expect.poll(async () => (await subscriptions(request, bob.token)).length).toBe(1);

      // Without an open tab a message pushes (once the node has seen the connection go).
      const bobOnline = async () => {
        const r = await request.get(`${NODE}/api/v1/presence`, { headers: { Authorization: `Bearer ${alice.token}` } });
        return ((await r.json()) as Array<{ user_id: string }>).some((p) => p.user_id === bob.userId);
      };
      await expect.poll(bobOnline).toBe(true);
      await page.close();
      await expect.poll(bobOnline).toBe(false);
      await postMessage(request, alice.token, channelId, "Hallo Bob, bist du da?");
      await expect.poll(() => service.received.filter((p) => p === `/push/${bob.username}`).length, { timeout: 15_000 }).toBe(2);

      // Signing out removes the subscription (the device goes with it).
      const again = await context.newPage();
      await again.goto("/");
      await expect(again.getByTestId("ws-status").first()).toHaveAttribute("data-status", "ready");
      await openNavIfMobile(again);
      await logoutViaUi(again);
      await expect(again).toHaveURL(/\/login/);
      const fresh = await loginViaApi(request, bob as Account, "check");
      await expect.poll(async () => (await subscriptions(request, fresh.token)).length).toBe(0);
      await context.close();
    } finally {
      service.server.close();
    }
  });

  test("the settings explain when the browser cannot push", async ({ page, request }) => {
    const alice = await registerViaApi(request, "alice");
    await page.addInitScript(() => {
      // A browser without the Push API (for example a private window).
      Reflect.deleteProperty(window, "PushManager");
    });
    await loginAs(page, alice);
    await page.goto("/settings/notifications");
    const push = page.getByTestId("push-settings");
    await expect(push).toHaveAttribute("data-status", /^(unsupported|install)$/);
    await expect(page.getByTestId("push-enable")).toBeDisabled();
    await expect(page.getByTestId("push-hint")).not.toBeEmpty();
  });
});
