// SPDX-License-Identifier: Apache-2.0
/** Encryption status of this device for the signed-in account (drives the unlock screen and banner). */
import { useRolePreview } from "./rolePreview";
import { create } from "zustand";
import { api, quietApi } from "../lib/api";
import { beginSignOut, onAccountChange, useAuth } from "./auth";
import { ensureDevice, localDeviceLost, localStatus, syncIdentity, wipeLocal, type E2eeContext } from "../crypto/e2ee";
import { cryptoStore, type CryptoStatus } from "../crypto/store";
import { useAuthFlow } from "./authFlow";
import { flushMls, getMls, ownIdentityRotated, resetMls } from "./mls";
import { signOutNodes } from "./nodes";
import { useConversationIndex } from "./conversationIndex";
import { rememberSsoLogout } from "../lib/sso";
import { wipeLocalIndex } from "../search/local";
import { usePush } from "./push";
import { forgetAttachments } from "../components/AttachmentView";
import { forgetThumbnails } from "../files/e2ee";
import { forgetRendered } from "../lib/markdown";
import { clearDrafts } from "../composer/drafts";
import { useInteractions } from "./interactions";

interface E2eeState {
  /** null until checked. */
  status: CryptoStatus | null;
  /**
   * This session's device lost its key (tavrn-web#83): its local key store is gone while the session lives on, and a
   * device key is immutable (ENCRYPTION.md §3.1). No unlock helps; encryption needs a new device (sign in again).
   */
  deviceLost: boolean;
  refresh: () => Promise<CryptoStatus>;
  /** Attests this device and tops up KeyPackages if needed (best effort, when unlocked). */
  ensureDevice: () => Promise<void>;
  set: (status: CryptoStatus) => void;
}

/** Whether an error is `@tavrn/e2ee`'s `device_key_lost`. */
export function isDeviceKeyLost(e: unknown): boolean {
  const named = e as { name?: string; code?: string } | null;
  return named?.name === "E2eeError" && named.code === "device_key_lost";
}

/** Marks this session's device as lost; the open session manager goes (its client state was dropped). */
export function markDeviceLost(): void {
  resetMls();
  useE2ee.setState({ deviceLost: true });
}

export const useE2ee = create<E2eeState>((set) => ({
  status: null,
  deviceLost: false,
  refresh: async () => {
    const { user, deviceId } = useAuth.getState();
    let status: CryptoStatus = "none";
    if (user) {
      try {
        // Local data of another device of this account (the login could not continue it): that device is gone
        // with its keys, so it is deleted on the node right away instead of lingering as a ghost (ENCRYPTION.md §4.7).
        status = await localStatus(user.address, deviceId ?? null, {
          onStaleDevice: async (old) => {
            await flushMls();
            if (old !== deviceId) await quietApi.users.deleteDevice(old).catch(() => undefined);
          },
        });
      } catch {
        status = "none"; // IndexedDB unavailable (private mode): degraded, like an empty store
      }
    }
    // Nothing local, yet the node holds a key for this session's device: the local data was lost, an unlock cannot
    // bring the key back (best effort; an unlocked device finds out in `ensureDevice`).
    let deviceLost = false;
    if (user && status === "none") deviceLost = await e2eeContext().then(localDeviceLost).catch(() => false);
    set({ status, deviceLost });
    return status;
  },
  ensureDevice: async () => {
    try {
      const ctx = await e2eeContext();
      // A rotation on another device (ENCRYPTION.md §9a): take the new key first; the session manager reopens with it.
      if ((await syncIdentity(ctx)) === "rotated") await ownIdentityRotated();
      // KeyPackages are created in the open session manager's state (in the tab that owns it), not next to it.
      await ensureDevice({ ...ctx, keyPackages: async (n) => (await getMls())?.createKeyPackages(n) ?? null });
    } catch (e) {
      // A device that lost its key (or kept a foreign one from earlier versions) signs nothing more.
      if (isDeviceKeyLost(e)) markDeviceLost();
      /* otherwise best effort: retried on the next start */
    }
  },
  set: (status) => set({ status }),
}));

/** Context for the flows in `crypto/e2ee`; resolves the device id of older stored sessions. */
export async function e2eeContext(): Promise<E2eeContext> {
  const { user, deviceId } = useAuth.getState();
  if (!user) throw new Error("not signed in");
  let id = deviceId ?? null;
  if (!id) {
    id = (await api.users.devices()).find((d) => d.current)?.id ?? null;
    if (!id) throw new Error("device id unknown");
    useAuth.getState().setDeviceId(id);
  }
  return { api, username: user.username, address: user.address, deviceId: id };
}

/**
 * Whatever the account had unlocked in this tab leaves memory when the account ends here, however it ends: the
 * explicit sign-out, a session the node refused (revoked on another device, an expired refresh), another tab signing
 * out or in with another account. The key store is locked (signing in again needs the recovery key or a passkey when
 * the account asks for it every time), the session manager goes, decrypted attachments, thumbnails and rendered
 * messages and unsent composer drafts are forgotten. The local data on disk stays unless the sign-out was explicit
 * ({@link signOut}).
 */
export function forgetUnlocked(): void {
  resetMls();
  forgetAttachments();
  forgetThumbnails();
  forgetRendered();
  clearDrafts();
  useInteractions.setState({ notices: [] });
  cryptoStore.lock();
  useE2ee.setState({ status: null, deviceLost: false });
}
onAccountChange(forgetUnlocked);

/**
 * Explicit sign-out: end the sessions on the home node and every other node, delete local crypto data,
 * forget everything in memory.
 */
export async function signOut(): Promise<void> {
  const user = useAuth.getState().user;
  // A role preview ends first: its write guard would refuse the sign-out's own requests (push, devices).
  useRolePreview.getState().exit();
  // The logout revokes the session at once: the socket and requests in flight see that before the logout's answer
  // arrives. The account stays signed in here until the provider's logout URL is kept and the local keys are gone.
  const endSignOut = beginSignOut();
  try {
    // Epoch keys not uploaded yet would be lost with the local data.
    await flushMls();
    await signOutNodes().catch(() => undefined);
    // No more pushes to this browser (the node also drops the subscription with the device).
    await usePush.getState().signOut().catch(() => undefined);
    // The local keys are deleted below: the device goes with them (no ghost leaves, no pile of old devices).
    const out = await api.auth.logout({ forgetDevice: true });
    // SSO session: offer "also sign out at the provider" on the login page (APPLICATIONS.md §8.6).
    if (out?.end_session_url) rememberSsoLogout(out.end_session_url);
  } finally {
    try {
      useConversationIndex.getState().reset();
      resetMls();
      // Decrypted attachments and thumbnails of this session go with the keys (object URLs revoked).
      forgetAttachments();
      forgetThumbnails();
      // The local search index goes with the other local data (tavrn-protocol/SEARCH.md §3.5).
      if (user) await wipeLocalIndex(user.address).catch(() => undefined);
      if (user) await wipeLocal(user.address);
      cryptoStore.lock();
      useAuthFlow.getState().clearPreauth();
      useAuthFlow.getState().setSetup(null);
      useE2ee.setState({ status: null, deviceLost: false });
    } finally {
      endSignOut();
    }
    useAuth.getState().logout();
  }
}
