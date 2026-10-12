// SPDX-License-Identifier: Apache-2.0
//! Native passkeys of the Linux app (docs/DESKTOP.md "Passkeys on Linux"). The app's window shows the bundled client
//! on `app://tavrn`, an origin that can never be under the node's relying party id, and Electron has no WebAuthn dialog
//! on Linux; so the shell runs the ceremony itself, as the Windows app does through the Windows WebAuthn API
//! (`apps/desktop/src-tauri/src/passkey.rs`), with the same contract:
//!
//! - in: the node's options (`{ publicKey }`, base64url values) and the **web origin of the node the app is connected
//!   to** (the shell's settings, never the page); a relying party id that this origin's host is not equal to or a
//!   subdomain of is refused (`passkey.refused`);
//! - the shell writes `clientDataJSON` itself with that origin, as a browser does, and hands its SHA-256 to the
//!   security key;
//! - out: the credential as `PublicKeyCredential.toJSON()`, and the PRF output (WebAuthn's `prf` extension over the key's
//!   hmac-secret) apart, base64url, for the key store only; it never reaches the node.
//!
//! The authenticators are **FIDO2 security keys over USB HID** (CTAP2 with the PIN protocol, resident keys, hmac-secret;
//! CTAP1/U2F keys sign in but have no PRF) through Mozilla's `authenticator` crate (a browser's CTAP2 library on Linux), with its
//! RustCrypto backend. Platform authenticators (fingerprint readers through fprintd), phones (hybrid) and NFC readers
//! are not supported: those passkeys keep going through the browser.
//!
//! [`options`] reads and checks the node's options, [`ctap`] maps them to the CTAP requests and the key's answers to the
//! browser's JSON, [`devices`] tells whether a security key is plugged in, and [`usb`] runs a ceremony with the user's
//! interaction (touch, PIN, the choice of a key or an account) reported as [`usb::Event`]s.

pub use authenticator;

pub mod ctap;
pub mod devices;
pub mod options;
#[cfg(target_os = "linux")]
pub mod usb;

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

/// The user cancelled, the prompt timed out, or the key holds no matching passkey (a browser's `NotAllowedError`).
pub const CANCELLED: &str = "passkey.cancelled";
/// The key already holds a passkey of the excluded ones (`InvalidStateError`).
pub const EXISTS: &str = "passkey.exists";
/// The relying party id does not belong to the node's origin, or the app has no node yet (`SecurityError`).
pub const REFUSED: &str = "passkey.refused";
/// No native passkeys here: no USB transport, or the key cannot do what the node asks (`NotSupportedError`).
pub const UNAVAILABLE: &str = "passkey.unavailable";
/// Anything else, including options the shell refuses to pass on and a blocked PIN.
pub const FAILED: &str = "passkey.failed";

pub(crate) fn b64() -> GeneralPurpose {
    GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
}

/// RFC 4648 §5 base64url without padding.
pub fn b64url(bytes: &[u8]) -> String {
    b64().encode(bytes)
}
