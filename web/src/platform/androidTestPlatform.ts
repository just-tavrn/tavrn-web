// SPDX-License-Identifier: Apache-2.0
/** Tests: a fake Android app platform (the members of `tauriAndroid.ts` without the shell). */
import { vi } from "vitest";
import type { AndroidInsets, PlatformAndroid, PushEndpointKeys } from "./types";
import type { Platform } from "./types";

export interface FakeAndroid extends PlatformAndroid {
  emitBack(): void;
  emitLink(url: string): void;
  emitInsets(insets: AndroidInsets): void;
  emitEndpoint(keys: PushEndpointKeys): void;
  emitUnregistered(): void;
}

export function fakeAndroid(opts: { webauthn?: boolean; distributors?: string[]; notifications?: "granted" | "denied" | "prompt"; permission?: "granted" | "denied" | "blocked" } = {}): FakeAndroid {
  const backs = new Set<() => void>();
  const links = new Set<(url: string) => void>();
  const insetsFns = new Set<(i: AndroidInsets) => void>();
  const endpoints = new Set<(k: PushEndpointKeys) => void>();
  const gone = new Set<() => void>();
  let insets: AndroidInsets = { top: 24, right: 0, bottom: 48, left: 0, keyboard: 0 };
  let n = 0;
  const sub = <T>(set: Set<T>, fn: T) => {
    set.add(fn);
    return () => void set.delete(fn);
  };
  return {
    sdk: 36,
    webauthn: opts.webauthn ?? false,
    status: vi.fn(async () => ({ sdk: 36, webauthn: opts.webauthn ?? false, distributors: opts.distributors ?? ["io.heckel.ntfy"], distributor: null, notifications: opts.notifications ?? "prompt", batteryExempt: false, keepConnection: false, insets })),
    requestPermission: vi.fn(async () => opts.permission ?? "granted"),
    openSettings: vi.fn(async () => undefined),
    requestBatteryExemption: vi.fn(async () => true),
    background: vi.fn(async () => undefined),
    onBack: (fn) => sub(backs, fn),
    onLink: (fn) => sub(links, fn),
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
    emitBack: () => backs.forEach((f) => f()),
    emitLink: (url) => links.forEach((f) => f(url)),
    emitInsets: (i) => {
      insets = i;
      insetsFns.forEach((f) => f(i));
    },
    emitEndpoint: (k) => endpoints.forEach((f) => f(k)),
    emitUnregistered: () => gone.forEach((f) => f()),
  };
}

export function androidPlatform(android: PlatformAndroid, domain = "tavrn.example"): Platform {
  return {
    kind: "android",
    isDesktop: true,
    nodeBase: () => `https://${domain}`,
    webOrigin: () => `https://app.${domain}`,
    openExternal: async () => {},
    appVersion: async () => "0.4.0",
    node: { current: () => `https://${domain}`, set: async () => {}, domain: () => domain },
    android,
  };
}
