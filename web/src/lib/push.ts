// SPDX-License-Identifier: Apache-2.0
/**
 * Web push in the browser (tavrn-protocol PROTOCOL.md §6d): the service worker (`public/sw.js`, push and
 * notification clicks only, no caching), the browser's `PushManager` subscription and the texts the worker shows.
 * The state per device and the calls to the home node are in `stores/push.ts`.
 */
import type { PushSubscriptionRequest } from "@tavrn/sdk";
import { t } from "../i18n";
import { navigateFromNotification } from "./notify";

/** Bump when `public/sw.js` changes in a way that needs a new registration (the URL carries the version). */
export const SW_VERSION = 1;
export const SW_URL = `/sw.js?v=${SW_VERSION}`;

/** Keys of the texts the service worker shows (`push.sw.<key>` in the translations). */
export const SW_STRING_KEYS = [
  "app",
  "message",
  "message_anonymous",
  "mention",
  "mention_anonymous",
  "dm",
  "dm_encrypted",
  "call",
  "call_from",
  "remote_message",
  "remote_mention",
  "remote_dm",
  "test",
  "generic",
] as const;

/** Service worker, push manager and notifications are all there (not in every browser, not in private windows). */
export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iPhone and iPad (iPadOS reports itself as a Mac with touch). */
export function isIos(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent, touchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/** Running as an installed web app (home screen). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

/** Safari on iPhone and iPad offers push only to web apps added to the home screen. */
export function needsInstall(ios = isIos(), standalone = isStandalone()): boolean {
  return ios && !standalone;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array | null | undefined): string {
  if (!bytes) return "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Was the browser subscription made with this VAPID key? (A replaced node key needs a new subscription.) */
export function subscribedWithKey(sub: Pick<PushSubscription, "options">, publicKey: string): boolean {
  return bytesToBase64Url(sub.options?.applicationServerKey ?? null) === publicKey.replace(/=+$/, "");
}

/** The node's request body from the browser's subscription. */
export function subscriptionRequest(json: PushSubscriptionJSON, deviceId: string | null): PushSubscriptionRequest {
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) throw new Error("incomplete push subscription");
  return {
    endpoint: json.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    ...(deviceId ? { device_id: deviceId } : {}),
    expiration_time: typeof json.expirationTime === "number" ? json.expirationTime : null,
  };
}

/** The translated texts of the service worker. */
export function workerStrings(translate: (key: string) => string = t): Record<string, string> {
  return Object.fromEntries(SW_STRING_KEYS.map((k) => [k, translate(`push.sw.${k}`)]));
}

/**
 * Registers the service worker (once per page load; a new `SW_VERSION` replaces the old one) and follows its
 * notification clicks. Never throws: without a worker there is simply no push.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type === "tavrn.push.open" && typeof d.url === "string" && d.url.startsWith("/")) navigateFromNotification(d.url);
    });
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    return null;
  }
}

/** The active registration (waits for the worker, at most a few seconds). */
export async function readyRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  const registration = existing ?? (await registerServiceWorker());
  if (!registration) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

/** Hands the worker the texts in the user's language and the home node (for the routes of a click). */
export async function sendWorkerConfig(homeNode: string | null): Promise<void> {
  const registration = await readyRegistration();
  registration?.active?.postMessage({ type: "tavrn.push.config", strings: workerStrings(), homeNode });
}
