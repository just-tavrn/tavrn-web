// SPDX-License-Identifier: Apache-2.0
//! End-to-end encryption of the native engine (ENCRYPTION.md §5a, VOICE.md §6), configured exactly like the web
//! client's key provider (`web/src/voice/keyProvider.ts`, LiveKit's `ExternalE2EEKeyProvider`): one shared key per
//! MLS epoch, derived in the webview from the MLS exporter and handed over per epoch; HKDF key derivation with
//! LiveKit's salt, AES-GCM, a ring of 256 keys at `epoch mod 256`, no ratcheting and no failure tolerance limit
//! (a frame that does not decrypt never invalidates a key). Receivers pick the key by the index in each frame
//! trailer; the sending key is the newest epoch's. Keys never reach a log or a file.

/// LiveKit's key ring holds at most 256 keys; the key index is one byte in every frame trailer.
pub const KEYRING_SIZE: u64 = 256;
/// LiveKit's default ratchet salt, also the HKDF salt of the key derivation (`livekit-client`'s `SALT`).
pub const RATCHET_SALT: &[u8] = b"LKFrameEncryptionKey";
/// Voice frame keys are 32 bytes (the MLS exporter output, ENCRYPTION.md §5a).
pub const KEY_LEN: usize = 32;

/// Key index of an MLS epoch: `epoch mod 256` (`voiceKeyIndex` of the web client).
pub fn key_index(epoch: u64) -> i32 {
    // The remainder is below 256: it always fits.
    i32::try_from(epoch % KEYRING_SIZE).unwrap_or(0)
}

/// Which epoch's key was handed to the engine last: epochs only move forward, so a late event for an older epoch
/// never makes an old key the sending key again (`VoiceKeyRing` of the web client).
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyRing {
    current: Option<u64>,
}

impl KeyRing {
    pub fn needs(&self, epoch: u64) -> bool {
        self.current.is_none_or(|c| epoch > c)
    }

    pub fn mark(&mut self, epoch: u64) {
        if self.needs(epoch) {
            self.current = Some(epoch);
        }
    }

    pub fn current(&self) -> Option<u64> {
        self.current
    }
}

/// A frame key from the webview: exactly 32 bytes.
pub fn validate_key(key: &[u8]) -> Result<(), &'static str> {
    if key.len() == KEY_LEN { Ok(()) } else { Err("voice.invalid_key") }
}

#[cfg(feature = "native-voice")]
pub use provider::*;

#[cfg(feature = "native-voice")]
mod provider {
    use livekit::e2ee::key_provider::{KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions};

    use super::*;

    /// The key provider options of the web client (`ExternalE2EEKeyProvider({ keyringSize: 256 })`).
    pub fn options() -> KeyProviderOptions {
        KeyProviderOptions {
            ratchet_window_size: 0,
            ratchet_salt: RATCHET_SALT.to_vec(),
            failure_tolerance: -1,
            key_ring_size: KEYRING_SIZE as i32,
            key_derivation_algorithm: KeyDerivationAlgorithm::HKDF,
        }
    }

    /// A shared-key provider holding the key of `epoch` at its index (the SDK's constructor also puts it at index
    /// 0, where a frame of another epoch fails to decrypt like with a missing key).
    pub fn provider(key: &[u8], epoch: u64) -> KeyProvider {
        let p = KeyProvider::with_shared_key(options(), key.to_vec());
        p.set_shared_key(key.to_vec(), key_index(epoch));
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_index_is_the_epoch_mod_256() {
        assert_eq!(key_index(0), 0);
        assert_eq!(key_index(5), 5);
        assert_eq!(key_index(255), 255);
        assert_eq!(key_index(256), 0);
        assert_eq!(key_index(513), 1);
        assert_eq!(key_index(u64::MAX), 255);
    }

    #[test]
    fn epochs_only_move_forward() {
        let mut ring = KeyRing::default();
        assert!(ring.needs(3));
        ring.mark(3);
        assert!(!ring.needs(3));
        assert!(!ring.needs(2));
        assert!(ring.needs(4));
        ring.mark(2);
        assert_eq!(ring.current(), Some(3));
    }

    #[test]
    fn keys_are_32_bytes() {
        assert!(validate_key(&[0u8; 32]).is_ok());
        assert_eq!(validate_key(&[0u8; 31]), Err("voice.invalid_key"));
        assert_eq!(validate_key(&[]), Err("voice.invalid_key"));
    }

    #[cfg(feature = "native-voice")]
    #[test]
    fn the_options_match_the_web_client() {
        let o = options();
        assert_eq!(o.ratchet_window_size, 0);
        assert_eq!(o.failure_tolerance, -1);
        assert_eq!(o.key_ring_size, 256);
        assert_eq!(o.ratchet_salt, b"LKFrameEncryptionKey");
        assert!(matches!(o.key_derivation_algorithm, livekit::e2ee::key_provider::KeyDerivationAlgorithm::HKDF));
    }
}
