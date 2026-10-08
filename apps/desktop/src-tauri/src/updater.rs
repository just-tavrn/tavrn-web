// SPDX-License-Identifier: Apache-2.0
//! Signed updates (tauri-plugin-updater, docs/DESKTOP.md "Updates"). The minisign public key lives in
//! tauri.conf.json; until the owner's key replaces the placeholder the app offers no updates.

/// The value tauri.conf.json carries until the owner's public key replaces it.
pub const PLACEHOLDER: &str = "REPLACE_WITH_THE_OWNERS_MINISIGN_PUBLIC_KEY";

/// Base64 of "untrusted comment:", the start of every key `tauri signer generate` writes.
const KEY_PREFIX: &str = "dW50cnVzdGVkIGNvbW1lbnQ6";

/// The update feed: the `latest.json` of the newest GitHub release of tavrn-web.
pub const ENDPOINT: &str = "https://github.com/just-tavrn/tavrn-web/releases/latest/download/latest.json";

/// True when `pubkey` looks like a real minisign public key (base64 of the key file), not the placeholder.
pub fn pubkey_configured(pubkey: &str) -> bool {
    let key = pubkey.trim();
    !key.contains(PLACEHOLDER)
        && key.starts_with(KEY_PREFIX)
        && key.len() >= 100
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

/// The updater's settings of tauri.conf.json (`plugins.updater`): is a usable key configured?
pub fn configured(plugin_config: Option<&serde_json::Value>) -> bool {
    plugin_config.and_then(|c| c.get("pubkey")).and_then(|k| k.as_str()).is_some_and(pubkey_configured)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A throwaway public key from `tauri signer generate` (its private key was never committed or used for releases).
    const SAMPLE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJCQkEyNjMwMjRDNTZCMDcKUldRSGE4VWtNQ2E2SzJqdGNjcGR6NUFYTUlIUDVveHZYMlhDZWpyTGxhMVVLM0J5T2FRbVNiR3YK";

    #[test]
    fn a_real_key_enables_updates() {
        assert!(pubkey_configured(SAMPLE));
        assert!(configured(Some(&json!({ "pubkey": SAMPLE, "endpoints": [ENDPOINT] }))));
    }

    #[test]
    fn the_placeholder_or_garbage_disables_updates() {
        assert!(!pubkey_configured(PLACEHOLDER));
        assert!(!pubkey_configured(&format!("{PLACEHOLDER} (docs/DESKTOP.md)")));
        assert!(!pubkey_configured(""));
        assert!(!pubkey_configured("dW50cnVzdGVkIGNvbW1lbnQ6"));
        assert!(!pubkey_configured(&format!("{SAMPLE}!")));
        assert!(!configured(None));
        assert!(!configured(Some(&json!({}))));
        assert!(!configured(Some(&json!({ "pubkey": 1 }))));
    }
}
