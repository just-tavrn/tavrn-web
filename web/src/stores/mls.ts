// SPDX-License-Identifier: Apache-2.0
/**
 * App integration of the MLS session manager: one manager per unlocked account and device, the
 * realtime events of ENCRYPTION.md §4.4 and the UI state around encryption (changed security keys,
 * rejoin warnings, ghost acknowledgements, unread DMs, verified contacts). Nothing secret is kept in
 * this store.
 */
import { create } from "zustand";
import { mlsApiOf, openMlsManager, qualify, reloadOwnIdentity, withBackupKey as withStoreBackupKey, type MlsEvent, type MlsManager, type VerifiedContact } from "@tavrn/e2ee";
import type { Channel } from "@tavrn/sdk";
import { api, homeBase } from "../lib/api";
import { apiFor, homeKeys, useNodes } from "./nodes";
import { useAuth } from "./auth";
import { cryptoStore } from "../crypto/store";
import { historyAdded, resetHistory } from "../crypto/history";

interface MlsUiState {
  /** Users whose security key changed (notice not acknowledged yet). */
  changedKeys: Record<string, true>;
  /** Users whose key was rotated with a valid continuity statement (soft notice not dismissed yet, ENCRYPTION.md §9a). */
  rotatedKeys: Record<string, true>;
  /** Conversations where this device had to rejoin after an invalid commit (session only). */
  rejoined: Record<string, true>;
  /** Incremented on every epoch change of a conversation: views re-check roster and messages. */
  epochs: Record<string, number>;
  /** Ghost warnings the user acknowledged in this session. */
  ghostAck: Record<string, true>;
  /** Conversation currently on screen. */
  open: string | null;
  /** Verified contacts, contacts whose key changed after the verification (§10.2) and rotated ones to verify again. */
  verification: Record<string, "verified" | "broken" | "refresh">;
}

export const useMlsUi = create<MlsUiState>(() => ({ changedKeys: {}, rotatedKeys: {}, rejoined: {}, epochs: {}, ghostAck: {}, open: null, verification: {} }));

/** The manager whose events update the store (verification states are read from it). */
let eventSource: MlsManager | null = null;

function onEvent(e: MlsEvent) {
  if (e.type === "added") return historyAdded(e.conversationId, e.addresses);
  useMlsUi.setState((s) => {
    switch (e.type) {
      case "key_changed":
        return { changedKeys: { ...s.changedKeys, [e.address]: true }, verification: eventSource?.verificationStates() ?? s.verification };
      case "key_rotated":
        return { rotatedKeys: { ...s.rotatedKeys, [e.address]: true }, verification: eventSource?.verificationStates() ?? s.verification };
      case "verification":
        return { verification: eventSource?.verificationStates() ?? s.verification };
      case "rejoined":
        return { rejoined: { ...s.rejoined, [e.conversationId]: true }, epochs: { ...s.epochs, [e.conversationId]: (s.epochs[e.conversationId] ?? 0) + 1 } };
      default:
        return { epochs: { ...s.epochs, [e.conversationId]: (s.epochs[e.conversationId] ?? 0) + 1 } };
    }
  });
}

/**
 * Runs `fn` with a fresh copy of the backup key (ENCRYPTION.md §2.1), zeroed afterwards; null while this
 * device is locked. Used for data the user keeps encrypted on the home node (whiteboard scenes).
 */
export function withBackupKey<T>(fn: (key: Uint8Array) => T): T | null {
  return withStoreBackupKey(cryptoStore, fn);
}

let current: { key: string; manager: Promise<MlsManager | null> } | null = null;

/**
 * Name of the Web Lock and the BroadcastChannel through which the tabs of this browser share the MLS state of an
 * account (`@tavrn/e2ee` tabs.ts): one tab owns and writes the state, the others forward their state-changing calls
 * to it. Per home node, account and device. The desktop app has one window, which always owns the state.
 */
export function mlsTabName(nodeBase: string, address: string, deviceId: string): string {
  return `tavrn-mls|${nodeBase}|${address}/${deviceId}`;
}

/**
 * The session manager of the signed-in account, or null while this device cannot decrypt (no master
 * secret, locked, or no device key yet). Created once per account and device.
 */
export function getMls(): Promise<MlsManager | null> {
  const { user, deviceId } = useAuth.getState();
  if (!user || !deviceId || !cryptoStore.isUnlocked(user.address)) return Promise.resolve(null);
  const key = `${user.address}/${deviceId}`;
  if (current?.key === key) return current.manager;
  current?.manager.then((m) => m?.dispose()).catch(() => undefined);
  const manager = (async () => {
    const m = await openMlsManager(cryptoStore, {
      api: mlsApiOf({ home: api, node: (domain) => apiFor(domain), keys: homeKeys }),
      address: user.address,
      deviceId,
      homeDomain: user.domain,
      onEvent,
      tabs: { name: mlsTabName(homeBase() || location.origin, user.address, deviceId) },
    });
    if (!m) return null;
    eventSource = m;
    if (inboxChannels?.account === user.address) for (const [q, w] of inboxChannels.wanted) m.setInboxWanted(q, w);
    useMlsUi.setState({
      changedKeys: Object.fromEntries(m.changedKeys().map((a) => [a, true as const])),
      rotatedKeys: Object.fromEntries(m.rotatedKeys().map((a) => [a, true as const])),
      verification: m.verificationStates(),
    });
    // New device (§8): history from the backups, then the Welcomes that arrived meanwhile, on the home
    // node and on every node with a session (DMs hosted by other users' home nodes, FEDERATION.md §6.1).
    void m.restoreBackups().catch(() => undefined);
    for (const domain of new Set([user.domain, ...Object.keys(useNodes.getState().sessions)])) void m.processWelcomes(domain).catch(() => undefined);
    // Uploads that a reload interrupted.
    if (m.hasPendingBackups()) void m.flushBackups().catch(() => undefined);
    return m;
  })().catch(() => {
    if (current?.key === key) current = null;
    return null;
  });
  current = { key, manager };
  return manager;
}

/**
 * What the rooms of the signed-in account showed about webhooks, per qualified channel id. A room often loads before
 * the manager exists (right after joining, while the device is still being set up or unlocked) and is not fetched
 * again: the manager opened later takes these over, or its own commits would publish no inbox key.
 */
let inboxChannels: { account: string; wanted: Map<string, boolean> } | null = null;

/**
 * Encrypted channels with webhooks (`has_webhooks`, APPLICATIONS.md §6.1a): the session manager publishes their inbox
 * keys after its own commits, and once right away so a webhook waiting for a key gets one. Others cost nothing.
 */
export async function syncInboxChannels(domain: string, channels: Pick<Channel, "id" | "encrypted" | "has_webhooks">[]): Promise<void> {
  const account = useAuth.getState().user?.address;
  if (!account) return;
  if (inboxChannels?.account !== account) inboxChannels = { account, wanted: new Map() };
  const wanted = channels.map((c) => [qualify(domain, c.id), c.encrypted && !!c.has_webhooks] as const);
  for (const [q, w] of wanted) inboxChannels.wanted.set(q, w);
  const m = await getMls();
  for (const [q, w] of wanted) m?.setInboxWanted(q, w);
}

/**
 * Uploads history backups that are still pending (ENCRYPTION.md §7) of the manager that exists right now (none is
 * created): before a sign-out or before local data is replaced, so no epoch key is lost with it.
 */
export async function flushMls(): Promise<void> {
  const m = await current?.manager.catch(() => null);
  if (m?.hasPendingBackups()) await m.flushBackups().catch(() => undefined);
}

/**
 * The account's identity key was rotated (here or on another device, ENCRYPTION.md §9a): the open manager verifies
 * its own devices against the new key; views keep their manager.
 */
export async function ownIdentityRotated(): Promise<void> {
  const m = await current?.manager.catch(() => null);
  if (m) await reloadOwnIdentity(m);
}

/** Sign-out, lock or identity change: forget the manager (state stays in the encrypted store). */
export function resetMls(): void {
  resetHistory();
  current?.manager.then((m) => m?.dispose()).catch(() => undefined);
  current = null;
  eventSource = null;
  useMlsUi.setState({ changedKeys: {}, rotatedKeys: {}, rejoined: {}, epochs: {}, ghostAck: {}, open: null, verification: {} });
}

function clearChanged(address: string) {
  useMlsUi.setState((s) => {
    const next = { ...s.changedKeys };
    delete next[address];
    const rotated = { ...s.rotatedKeys };
    delete rotated[address];
    return { changedKeys: next, rotatedKeys: rotated };
  });
}

/** Hides the "verification needs a refresh" notice of a contact whose key was rotated (ENCRYPTION.md §9a). */
export async function dismissVerificationRefresh(address: string): Promise<void> {
  const m = await getMls();
  await m?.dismissVerificationRefresh(address);
}

/**
 * Looks the user's key up again on their home node (a `system.key_changed` entry or `identity.rotated`): a rotation
 * with continuity is pinned with the soft notice, anything else gets the warning. Once per address unless something
 * newer than the last lookup (`since`, ms) asks for it.
 */
const rechecked = new Map<string, number>();
export async function recheckKey(address: string, since = Date.now()): Promise<void> {
  const last = rechecked.get(address);
  if (last !== undefined && last >= since) return;
  rechecked.set(address, Date.now());
  const m = await getMls();
  if (!m || address === m.address) return;
  m.identityChanged(address);
  await m.verifiedDevices(address).catch(() => null);
}

export async function acknowledgeKeyChange(address: string): Promise<void> {
  const m = await getMls();
  await m?.acknowledgeKeyChange(address);
  clearChanged(address);
}

/** Marks the contact's current key as verified (after comparing the safety number or the QR code). */
export async function markVerified(address: string, method: VerifiedContact["method"]): Promise<boolean> {
  const m = await getMls();
  const ok = (await m?.markVerified(address, method)) ?? false;
  if (ok) clearChanged(address);
  return ok;
}

export async function removeVerification(address: string): Promise<void> {
  const m = await getMls();
  await m?.removeVerification(address);
}

/** "I trust the new key": accepts a changed key of a verified contact without verifying again. */
export async function acceptNewKey(address: string): Promise<void> {
  const m = await getMls();
  await m?.acceptNewKey(address);
  clearChanged(address);
}
