// SPDX-License-Identifier: Apache-2.0
// A forced sign-out (the node refused the session: revoked on another device, refresh expired) ends the account in this
// tab like the explicit sign-out does in memory: the key store is locked, the session manager goes, decrypted
// attachments and rendered messages are forgotten. Signing in again in the same tab then needs the recovery key or a
// passkey again when the account asks for it every time ("lock on close").
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UserPrivate } from "@tavrn/sdk";
import { initCryptoForTests } from "../test/wasm";
import { cryptoStore } from "../crypto/store";
import { useAuth } from "./auth";
import { useE2ee } from "./e2ee";
import { useMlsUi } from "./mls";
import { useInteractions } from "./interactions";
import { loadAttachment, type ViewAttachment } from "../components/AttachmentView";

const ALICE = "alice@home.test";
const DEV = "01J9ZK3G5M8Q2W4E6R8T0Y2VA1";
const signIn = () => useAuth.setState({ token: "t", refresh: "r", user: { id: "a", address: ALICE, username: "alice", domain: "home.test" } as unknown as UserPrivate, deviceId: DEV, home: null });

beforeAll(() => initCryptoForTests());

describe("a forced sign-out", () => {
  afterEach(() => {
    cryptoStore.lock();
    useAuth.setState({ token: null, refresh: null, user: null, deviceId: null });
  });

  it("locks the key store: resuming in this tab needs the key again with lock on close", async () => {
    signIn();
    await cryptoStore.saveMaster(ALICE, DEV, new Uint8Array(32).fill(7), { lockOnClose: true });
    useE2ee.setState({ status: "unlocked" });
    expect(cryptoStore.isUnlocked(ALICE)).toBe(true);
    useAuth.getState().sessionRefused();
    expect(useAuth.getState().user).toBeNull();
    expect(cryptoStore.isUnlocked()).toBe(false);
    expect(useE2ee.getState().status).toBeNull();
    signIn();
    expect(await cryptoStore.resume(ALICE)).toBe(false);
    expect(await cryptoStore.status(ALICE)).toBe("locked");
  });

  it("forgets the decrypted attachments of the session", async () => {
    signIn();
    const secret = new TextEncoder().encode("alice's decrypted photo");
    const a: ViewAttachment = { id: "01SECRETATTACHMENT00000000", name: "p.png", mime: "image/png", size: secret.length, encrypted: null };
    const home = { attachments: { download: async () => new Blob([secret]) } } as never;
    await loadAttachment(home, a);
    useAuth.getState().sessionRefused();
    const gone = { attachments: { download: async () => Promise.reject(new Error("not downloaded")) } };
    // The same node client asks again: nothing is handed out from memory.
    (home as { attachments: unknown }).attachments = gone.attachments;
    await expect(loadAttachment(home, a)).rejects.toThrow("not downloaded");
  });

  it("drops the session manager's state and the bots' notices", () => {
    signIn();
    useMlsUi.setState({ open: "01CONV", epochs: { x: 1 } as never });
    useInteractions.getState().add({ interactionId: "i", conversationId: "c", messageId: null, kind: "ephemeral", application: null, content: { type: "text", body: "x" } } as never);
    useAuth.getState().sessionRefused();
    expect(useMlsUi.getState().open).toBeNull();
    expect(useInteractions.getState().notices).toEqual([]);
  });
});
