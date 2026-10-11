// SPDX-License-Identifier: Apache-2.0
/** Encryption status of this device for the signed-in account (drives the unlock screen and banner). */
import { create } from "zustand";
import { api, quietApi } from "../lib/api";
import { useAuth } from "./auth";
import { ensureDevice, localStatus, syncIdentity, wipeLocal, type E2eeContext } from "../crypto/e2ee";
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

interface E2eeState {
  /** null until checked. */
  status: CryptoStatus | null;
  refresh: () => Promise<CryptoStatus>;
  /** Attests this device and tops up KeyPackages if needed (best effort, when unlocked). */
  ensureDevice: () => Promise<void>;
  set: (status: CryptoStatus) => void;
}

export const useE2ee = create<E2eeState>((set) => ({
  status: null,
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
    set({ status });
    return status;
  },
  ensureDevice: async () => {
    try {
      const ctx = await e2eeContext();
      // A rotation on another device (ENCRYPTION.md §9a): take the new key first; the session manager reopens with it.
      if ((await syncIdentity(ctx)) === "rotated") await ownIdentityRotated();
      // KeyPackages are created in the open session manager's state (in the tab that owns it), not next to it.
      await ensureDevice({ ...ctx, keyPackages: async (n) => (await getMls())?.createKeyPackages(n) ?? null });
    } catch {
      /* best effort: retried on the next start */
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
 * Explicit sign-out: end the sessions on the home node and every other node, delete local crypto data,
 * forget everything in memory.
 */
export async function signOut(): Promise<void> {
  const user = useAuth.getState().user;
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
    useE2ee.setState({ status: null });
    useAuth.getState().logout();
  }
}
