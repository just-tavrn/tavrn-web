// SPDX-License-Identifier: Apache-2.0
/**
 * LiveKit key provider for tavrn voice (ENCRYPTION.md §5a): one shared key per MLS epoch, imported as
 * HKDF key material and set at `keyIndex = epoch mod 256` in a ring of 256, no ratcheting, no key
 * invalidation on decryption failures (the settings of `ExternalE2EEKeyProvider` plus the ring size).
 * Setting a key with an index makes it the sending key; receivers pick keys by the index in each frame.
 * Imports livekit-client: only loaded with the voice session.
 */
import { ExternalE2EEKeyProvider, createKeyMaterialFromBuffer } from "livekit-client";
import { KEYRING_SIZE, VoiceKeyRing, voiceKeyIndex } from "./keys";

export class TavrnKeyProvider extends ExternalE2EEKeyProvider {
  readonly ring = new VoiceKeyRing();

  constructor() {
    super({ keyringSize: KEYRING_SIZE });
  }

  /**
   * Hands the frame key of `epoch` to LiveKit (and to its worker). Keys of older epochs than the newest
   * one set are ignored, so a late event never turns an old key back into the sending key.
   * Returns whether the key was set.
   */
  async setEpochKey(key: Uint8Array, epoch: number): Promise<boolean> {
    if (key.length !== 32) throw new RangeError("voice frame keys are 32 bytes");
    if (!this.ring.needs(epoch)) return false;
    // WebCrypto copies the key bytes on import: the copy made for it is wiped right after.
    const copy = key.slice();
    let material: CryptoKey;
    try {
      material = await createKeyMaterialFromBuffer(copy.buffer);
    } finally {
      copy.fill(0);
    }
    if (!this.ring.needs(epoch)) return false;
    this.ring.mark(epoch);
    this.onSetEncryptionKey(material, undefined, voiceKeyIndex(epoch));
    return true;
  }
}
