// SPDX-License-Identifier: Apache-2.0
/**
 * Web push on this device (tavrn-protocol PROTOCOL.md §6d). The home node pushes while no tab of the client is
 * connected (call rings also while one is; the service worker skips them while a page is visible); this store keeps the browser's push subscription and its registration on the home node in step:
 *
 * - `init` (after sign-in): learns whether the node pushes, re-registers an enabled device (a replaced VAPID key
 *   or a lost subscription is renewed) and hands the service worker its texts.
 * - `enable` (from a click: the browser asks for permission only then) and `disable`.
 * - `signOut`: removes the subscription before the session ends (the node also drops it with the device).
 *
 * Per account and browser, `localStorage` remembers the registration id and the key it was made with.
 *
 * The Android app has no service worker: its push comes through UnifiedPush (docs/ANDROID.md "Notifications without
 * Google"). The user's distributor hands an endpoint with RFC 8291 keys, which is registered at the node exactly like
 * a browser subscription; the app's native receiver decrypts and shows the pushes. Without a distributor the status is
 * `no_distributor` (the settings explain where to get one and offer the connection service instead).
 */
import { create } from "zustand";
import { TavrnApiError, type TavrnApi } from "@tavrn/sdk";
import type { PushSubscriptionRequest } from "@tavrn/sdk";
import { needsInstall, pushSupported, readyRegistration, sendWorkerConfig, subscribedWithKey, subscriptionRequest, base64UrlToBytes, workerStrings } from "../lib/push";
import { platform, type PlatformAndroid, type PushEndpointKeys } from "../platform";

export type PushStatus = "loading" | "unsupported" | "install" | "unavailable" | "denied" | "no_distributor" | "off" | "on";

type PushApi = Pick<TavrnApi, "push">;

interface Record_ {
  id: string;
  key: string;
}

interface PushState {
  status: PushStatus;
  busy: boolean;
  error: string | null;
  init: (ctx: PushContext) => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  test: () => Promise<void>;
  signOut: () => Promise<void>;
  reset: () => void;
}

export interface PushContext {
  api: PushApi;
  /** Address of the account (the key of the local record). */
  account: string;
  /** Domain of the home node (notification clicks route its rooms without `/n/`). */
  homeNode: string;
  deviceId: string | null;
}

const KEY = "tavrn.push";
let ctxRef: PushContext | null = null;
/** Android: the listener of renewed endpoints. */
let stopEndpoints: (() => void) | null = null;

function readRecord(account: string): Record_ | null {
  try {
    const raw = localStorage.getItem(`${KEY}:${account}`);
    const r = raw ? (JSON.parse(raw) as Partial<Record_>) : null;
    return r && typeof r.id === "string" && typeof r.key === "string" ? { id: r.id, key: r.key } : null;
  } catch {
    return null;
  }
}

function writeRecord(account: string, r: Record_ | null) {
  try {
    if (r) localStorage.setItem(`${KEY}:${account}`, JSON.stringify(r));
    else localStorage.removeItem(`${KEY}:${account}`);
  } catch {
    /* storage disabled: the device registers again next time */
  }
}

function permission(): NotificationPermission {
  return typeof Notification === "undefined" ? "denied" : Notification.permission;
}

/** Subscribes the browser with the node's key (renewing a subscription made with another key) and registers it. */
async function register(ctx: PushContext, publicKey: string): Promise<Record_> {
  const registration = await readyRegistration();
  if (!registration) throw new Error("service worker unavailable");
  let sub = await registration.pushManager.getSubscription();
  if (sub && !subscribedWithKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  const subscribe = () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  sub ??= await subscribe();
  let saved;
  try {
    saved = await ctx.api.push.subscribe(subscriptionRequest(sub.toJSON(), ctx.deviceId));
  } catch (e) {
    // The endpoint belongs to another account's live subscription (PROTOCOL.md §6d): a new browser subscription
    // gets a new endpoint for this account.
    if (!(e instanceof TavrnApiError && e.code === "push.endpoint_taken")) throw e;
    await sub.unsubscribe().catch(() => false);
    sub = await subscribe();
    saved = await ctx.api.push.subscribe(subscriptionRequest(sub.toJSON(), ctx.deviceId));
  }
  const record = { id: saved.id, key: publicKey };
  writeRecord(ctx.account, record);
  return record;
}

/** The node's request body from a UnifiedPush endpoint. */
export function endpointRequest(keys: PushEndpointKeys, deviceId: string | null): PushSubscriptionRequest {
  return { endpoint: keys.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, ...(deviceId ? { device_id: deviceId } : {}), expiration_time: null };
}

/** Android: registers at the distributor with the node's key and the endpoint at the node. */
async function registerAndroid(android: PlatformAndroid, ctx: PushContext, publicKey: string): Promise<Record_> {
  let keys = await android.push.register(publicKey);
  let saved;
  try {
    saved = await ctx.api.push.subscribe(endpointRequest(keys, ctx.deviceId));
  } catch (e) {
    // Another account of this device had the endpoint: a new registration gets a new one.
    if (!(e instanceof TavrnApiError && e.code === "push.endpoint_taken")) throw e;
    await android.push.unregister().catch(() => undefined);
    keys = await android.push.register(publicKey);
    saved = await ctx.api.push.subscribe(endpointRequest(keys, ctx.deviceId));
  }
  const record = { id: saved.id, key: publicKey };
  writeRecord(ctx.account, record);
  return record;
}

/** Android: the distributor renewed the endpoint while the app runs; the node gets it at once. */
function followEndpoints(android: PlatformAndroid, ctx: PushContext) {
  stopEndpoints?.();
  const offEndpoint = android.push.onEndpoint((keys) => {
    if (ctxRef !== ctx || !readRecord(ctx.account)) return;
    void ctx.api.push
      .subscribe(endpointRequest(keys, ctx.deviceId))
      .then((saved) => {
        const record = readRecord(ctx.account);
        if (record) writeRecord(ctx.account, { ...record, id: saved.id });
      })
      .catch(() => undefined);
  });
  const offGone = android.push.onUnregistered(() => {
    if (ctxRef !== ctx) return;
    void unsubscribe(ctx).catch(() => undefined);
    usePush.setState({ status: "off" });
  });
  stopEndpoints = () => {
    offEndpoint();
    offGone();
  };
}

async function initAndroid(android: PlatformAndroid, ctx: PushContext, set: (s: Partial<PushState>) => void): Promise<void> {
  const vapid = await ctx.api.push.vapid().catch(() => null);
  if (ctxRef !== ctx) return;
  if (!vapid?.enabled || !vapid.public_key) return set({ status: "unavailable" });
  void android.push.configure(workerStrings(), ctx.homeNode).catch(() => undefined);
  const status = await android.status().catch(() => null);
  if (ctxRef !== ctx) return;
  const record = readRecord(ctx.account);
  if (!status?.distributors.length) return set({ status: "no_distributor" });
  if (status.notifications === "denied" && record) return set({ status: "denied" });
  if (!record) return set({ status: "off" });
  followEndpoints(android, ctx);
  try {
    await registerAndroid(android, ctx, vapid.public_key);
    if (ctxRef === ctx) set({ status: "on" });
  } catch (e) {
    if (ctxRef === ctx) set({ status: "on", error: message(e) });
  }
}

async function enableAndroid(android: PlatformAndroid, ctx: PushContext, set: (s: Partial<PushState>) => void): Promise<void> {
  // First, while the click still counts: the system's permission prompt (Android 13 and newer).
  const answer = await android.requestPermission("notifications");
  if (answer !== "granted") return set({ status: answer === "blocked" ? "denied" : "off" });
  const vapid = await ctx.api.push.vapid();
  if (!vapid.enabled || !vapid.public_key) return set({ status: "unavailable" });
  await android.push.configure(workerStrings(), ctx.homeNode).catch(() => undefined);
  followEndpoints(android, ctx);
  await registerAndroid(android, ctx, vapid.public_key);
  set({ status: "on" });
}

const message = (e: unknown) => (e instanceof TavrnApiError ? e.problem.code ?? e.message : e instanceof Error ? e.message : String(e));

export const usePush = create<PushState>((set, get) => ({
  status: "loading",
  busy: false,
  error: null,
  init: async (ctx) => {
    ctxRef = ctx;
    set({ status: "loading", error: null });
    const android = platform().android;
    if (android) return initAndroid(android, ctx, set);
    if (!pushSupported()) return set({ status: needsInstall() ? "install" : "unsupported" });
    const vapid = await ctx.api.push.vapid().catch(() => null);
    if (ctxRef !== ctx) return;
    if (!vapid?.enabled || !vapid.public_key) return set({ status: "unavailable" });
    void sendWorkerConfig(ctx.homeNode).catch(() => undefined);
    const record = readRecord(ctx.account);
    if (permission() === "denied") return set({ status: "denied" });
    if (!record || permission() !== "granted") return set({ status: "off" });
    // Enabled on this device: renew the registration (idempotent on the node; a replaced key subscribes again).
    try {
      await register(ctx, vapid.public_key);
      if (ctxRef === ctx) set({ status: "on" });
    } catch (e) {
      if (ctxRef === ctx) set({ status: "on", error: message(e) });
    }
  },
  enable: async () => {
    const ctx = ctxRef;
    if (!ctx || get().busy) return;
    set({ busy: true, error: null });
    try {
      const android = platform().android;
      if (android) return await enableAndroid(android, ctx, set);
      // First, while the click still counts as a user action: the browser's permission prompt.
      const result = permission() === "default" ? await Notification.requestPermission() : permission();
      if (result !== "granted") return set({ status: result === "denied" ? "denied" : "off" });
      const vapid = await ctx.api.push.vapid();
      if (!vapid.enabled || !vapid.public_key) return set({ status: "unavailable" });
      await sendWorkerConfig(ctx.homeNode).catch(() => undefined);
      await register(ctx, vapid.public_key);
      set({ status: "on" });
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ busy: false });
    }
  },
  disable: async () => {
    const ctx = ctxRef;
    if (!ctx || get().busy) return;
    set({ busy: true, error: null });
    try {
      await unsubscribe(ctx);
      set({ status: !platform().android && permission() === "denied" ? "denied" : "off" });
    } catch (e) {
      set({ error: message(e) });
    } finally {
      set({ busy: false });
    }
  },
  test: async () => {
    const ctx = ctxRef;
    if (!ctx) return;
    set({ error: null });
    try {
      await ctx.api.push.test();
    } catch (e) {
      set({ error: message(e) });
    }
  },
  signOut: async () => {
    const ctx = ctxRef;
    if (ctx) await unsubscribe(ctx).catch(() => undefined);
    get().reset();
  },
  reset: () => {
    ctxRef = null;
    stopEndpoints?.();
    stopEndpoints = null;
    set({ status: "loading", busy: false, error: null });
  },
}));

/** Deletes the registration on the node and the browser's subscription. */
async function unsubscribe(ctx: PushContext): Promise<void> {
  const record = readRecord(ctx.account);
  writeRecord(ctx.account, null);
  if (record) {
    await ctx.api.push.unsubscribe(record.id).catch((e: unknown) => {
      // Already gone on the node (sign-out elsewhere, 410 of the push service): nothing to undo.
      if (!(e instanceof TavrnApiError && e.status === 404)) throw e;
    });
  }
  const android = platform().android;
  if (android) return android.push.unregister();
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  const sub = await registration?.pushManager.getSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => false);
}
