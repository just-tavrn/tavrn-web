// SPDX-License-Identifier: Apache-2.0
/** Tests: a fake Android app platform (the members of `tauriAndroid.ts` without the shell). */
import { vi } from "vitest";
import type { AndroidInsets, AudioRoute, AudioRoutes, PlatformAndroid, PushEndpointKeys } from "./types";
import type { Platform, PlatformPasskeys } from "./types";

export interface FakeAndroid extends PlatformAndroid {
  emitBack(): void;
  emitInsets(insets: AndroidInsets): void;
  emitEndpoint(keys: PushEndpointKeys): void;
  emitUnregistered(): void;
  emitRoutes(routes: AudioRoutes): void;
}

/** The origin of the fake app (a fake SHA-256 in base64url: 32 zero bytes). */
export const FAKE_APP_ORIGIN = `android:apk-key-hash:${"A".repeat(43)}`;

export function fakeAndroid(opts: { webauthn?: boolean; passkeys?: boolean; origin?: string | null; distributors?: string[]; notifications?: "granted" | "denied" | "prompt"; permission?: "granted" | "denied" | "blocked"; routes?: AudioRoutes } = {}): FakeAndroid {
  const backs = new Set<() => void>();
  const insetsFns = new Set<(i: AndroidInsets) => void>();
  const endpoints = new Set<(k: PushEndpointKeys) => void>();
  const gone = new Set<() => void>();
  const routeFns = new Set<(r: AudioRoutes) => void>();
  let routes: AudioRoutes = opts.routes ?? { available: ["speaker", "earpiece"], current: "speaker" };
  let insets: AndroidInsets = { top: 24, right: 0, bottom: 48, left: 0, keyboard: 0 };
  let n = 0;
  const sub = <T>(set: Set<T>, fn: T) => {
    set.add(fn);
    return () => void set.delete(fn);
  };
  return {
    sdk: 36,
    webauthn: opts.webauthn ?? false,
    passkeys: opts.passkeys ?? false,
    origin: opts.origin === undefined ? FAKE_APP_ORIGIN : opts.origin,
    status: vi.fn(async () => ({ sdk: 36, webauthn: opts.webauthn ?? false, passkeys: opts.passkeys ?? false, origin: opts.origin === undefined ? FAKE_APP_ORIGIN : opts.origin, distributors: opts.distributors ?? ["io.heckel.ntfy"], distributor: null, notifications: opts.notifications ?? "prompt", batteryExempt: false, keepConnection: false, insets })),
    requestPermission: vi.fn(async () => opts.permission ?? "granted"),
    openSettings: vi.fn(async () => undefined),
    requestBatteryExemption: vi.fn(async () => true),
    background: vi.fn(async () => undefined),
    onBack: (fn) => sub(backs, fn),
    onInsets: (fn) => sub(insetsFns, fn),
    insets: () => insets,
    push: {
      register: vi.fn(async () => ({ endpoint: `https://ntfy.example/up${++n}`, p256dh: "B".repeat(87), auth: "a".repeat(22) })),
      unregister: vi.fn(async () => undefined),
      configure: vi.fn(async () => undefined),
      onEndpoint: (fn) => sub(endpoints, fn),
      onUnregistered: (fn) => sub(gone, fn),
    },
    keepConnection: vi.fn(async () => undefined),
    audio: {
      routes: vi.fn(async () => routes),
      setRoute: vi.fn(async (route: AudioRoute) => {
        routes = { ...routes, current: route };
        return routes;
      }),
      onRoutes: (fn) => sub(routeFns, fn),
    },
    lockOrientation: vi.fn(async () => undefined),
    emitBack: () => backs.forEach((f) => f()),
    emitInsets: (i) => {
      insets = i;
      insetsFns.forEach((f) => f(i));
    },
    emitEndpoint: (k) => endpoints.forEach((f) => f(k)),
    emitUnregistered: () => gone.forEach((f) => f()),
    emitRoutes: (r) => {
      routes = r;
      routeFns.forEach((f) => f(r));
    },
  };
}

/** The Android app's platform; with `android.passkeys` its native ceremonies are `passkeys` (fakes by default). */
export function androidPlatform(android: PlatformAndroid, domain = "tavrn.example", passkeys?: PlatformPasskeys): Platform {
  return {
    kind: "android",
    isDesktop: true,
    nodeBase: () => `https://${domain}`,
    webOrigin: () => `https://app.${domain}`,
    openExternal: async () => {},
    appVersion: async () => "0.4.0",
    node: { current: () => `https://${domain}`, set: async () => {}, domain: () => domain },
    android,
    ...(android.passkeys ? { passkeys: passkeys ?? { create: vi.fn(), get: vi.fn() } } : {}),
  };
}
