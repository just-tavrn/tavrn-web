// SPDX-License-Identifier: Apache-2.0
/**
 * The platform layer (docs/DESKTOP.md): which platform runs the client and where its node lives. Every place
 * that used to take "the origin the client was loaded from" asks here instead, so the desktop app can talk to
 * the node the user picked. The Tauri implementation is loaded only when the Tauri runtime is detected: the
 * browser never runs Tauri code.
 */
import { browserPlatform } from "./browser";
import { detectTauri } from "./tauriDetect";
import type { Platform } from "./types";

export type { AvailableUpdate, AppUpdater, NodeChoice, Platform, PlatformKind } from "./types";

let current: Platform = browserPlatform;

/** The platform of this client (the browser until {@link initPlatform} found the desktop app). */
export function platform(): Platform {
  return current;
}

type TauriModule = { createTauriPlatform: () => Promise<Platform> };

/** Detects the platform once at start-up, before the client renders. */
export async function initPlatform(detect: () => boolean = detectTauri, load: () => Promise<TauriModule> = () => import("./tauri")): Promise<Platform> {
  if (detect()) current = await (await load()).createTauriPlatform();
  return current;
}

/** Tests: run as another platform. */
export function setPlatform(p: Platform): void {
  current = p;
}

/** Tests: back to the browser. */
export function resetPlatform(): void {
  current = browserPlatform;
}

/** Base URL for the API client of the client's node (`""`: same origin). */
export function apiBase(): string {
  return current.nodeBase();
}

/** Absolute URL of the client's node: the origin in the browser, the chosen node in the desktop app. */
export function originUrl(): string {
  return current.nodeBase() || location.origin;
}

/** WebSocket of the client's node. */
export function originWsUrl(): string {
  return `${originUrl().replace(/^http/, "ws")}/api/v1/ws`;
}

/** Origin of the node's web client: links for other people (invites, messages, channels). */
export function webOrigin(): string {
  return current.webOrigin();
}

/** Host (with port) of the client's node, where the browser used `location.host`. */
export function originHost(): string {
  return new URL(originUrl()).host;
}

/** Name of a new device of this platform, as the node lists it under the account's devices. */
export function deviceName(): string {
  return current.isDesktop ? "Desktop app" : "Browser";
}

/** Nodes in development mode speak plain HTTP; only a client of such a node accepts http peers. */
export function allowsInsecureNodes(): boolean {
  return originUrl().startsWith("http:");
}
