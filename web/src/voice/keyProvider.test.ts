// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { KeyProviderEvent } from "livekit-client";
import { TavrnKeyProvider } from "./keyProvider";

const key = (fill: number) => new Uint8Array(32).fill(fill);

describe("TavrnKeyProvider (ENCRYPTION.md §5a)", () => {
  it("uses LiveKit's shared-key settings with a ring of 256 and no ratcheting", () => {
    const p = new TavrnKeyProvider();
    expect(p.getOptions()).toMatchObject({ sharedKey: true, keyringSize: 256, ratchetWindowSize: 0, failureTolerance: -1, ratchetSalt: "LKFrameEncryptionKey", keySize: 128 });
  });

  it("sets each epoch's key as HKDF material at index epoch mod 256 and makes it the sending key", async () => {
    const p = new TavrnKeyProvider();
    const seen: Array<{ index?: number; current: boolean; algorithm: string }> = [];
    p.on(KeyProviderEvent.SetKey, (info, current) => seen.push({ index: info.keyIndex, current: !!current, algorithm: info.key.algorithm.name }));
    expect(await p.setEpochKey(key(1), 7)).toBe(true);
    expect(await p.setEpochKey(key(2), 263)).toBe(true);
    expect(seen).toEqual([
      { index: 7, current: true, algorithm: "HKDF" },
      { index: 7, current: true, algorithm: "HKDF" },
    ]);
    expect(p.getLatestManuallySetKeyIndex()).toBe(7);
    expect(p.getKeys().map((k) => k.keyIndex)).toEqual([7]);
  });

  it("ignores keys of older epochs and rejects malformed keys", async () => {
    const p = new TavrnKeyProvider();
    await p.setEpochKey(key(1), 10);
    expect(await p.setEpochKey(key(9), 9)).toBe(false);
    expect(p.getLatestManuallySetKeyIndex()).toBe(10);
    await expect(p.setEpochKey(new Uint8Array(16), 11)).rejects.toThrow();
  });
});
