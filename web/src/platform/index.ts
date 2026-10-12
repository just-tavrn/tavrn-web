// SPDX-License-Identifier: Apache-2.0
/**
 * The platform layer (docs/DESKTOP.md): which platform runs the client and where its node lives. Every place
 * that used to take "the origin the client was loaded from" asks here instead, so the desktop app can talk to
 * the node the user picked. The desktop implementations are loaded only when their shell is detected (Tauri on
 * Windows and macOS, `tauri.ts`; Electron on Linux, `electron.ts`): the browser never runs shell code.
 */
import { browserPlatform } from "./browser";
import { detectElectron } from "./electronDetect";
import { detectTauri } from "./tauriDetect";
import type { Platform } from "./types";

export type { AndroidInsets, AndroidPermission, AndroidStatus, PermissionAnswer, PlatformAndroid, PushEndpointKeys, AvailableUpdate, AppUpdater, HotkeyAction, HotkeyEvent, NodeChoice, NodeDetails, NodePageMethod, NodePageMode, NodePageResult, NodePageSignIn, NodePageUnlock, Platform, PlatformAuth, PlatformHotkeys, PlatformKind, PlatformVoice, NativeDevice, NativeParticipant, NativeVoiceConfig, NativeVoiceEvent, NativeVoiceJoin, ResolvedNode, ResolveFailure } from "./types";

let current: Platform = browserPlatform;

/** The platform of this client (the browser until {@link initPlatform} found the desktop app). */
export function platform(): Platform {
  return current;
}

type TauriModule = { createTauriPlatform: () => Promise<Platform> };
type ElectronModule = { createElectronPlatform: () => Promise<Platform> };

/** The Electron shell's detection and loader (tests pass fakes). */
export interface ElectronShell {
  detect: () => boolean;
  load: () => Promise<ElectronModule>;
}

const electronShell: ElectronShell = { detect: detectElectron, load: () => import("./electron") };

/** Detects the platform once at start-up, before the client renders: the Tauri shell, then the Electron shell. */
export async function initPlatform(
  detect: () => boolean = detectTauri,
  load: () => Promise<TauriModule> = () => import("./tauri"),
  electron: ElectronShell = electronShell,
): Promise<Platform> {
  if (detect()) current = await (await load()).createTauriPlatform();
  else if (electron.detect()) current = await (await electron.load()).createElectronPlatform();
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
  return current.kind === "android" ? "Android app" : current.isDesktop ? "Desktop app" : "Browser";
}

/** Nodes in development mode speak plain HTTP; only a client of such a node accepts http peers. */
export function allowsInsecureNodes(): boolean {
  return originUrl().startsWith("http:");
}
