// SPDX-License-Identifier: Apache-2.0
//! Signed updates (tauri-plugin-updater, docs/DESKTOP.md "Updates"). The minisign public key lives in
//! tauri.conf.json; until the owner's key replaces the placeholder the app offers no updates.
//!
//! The feed is the website's per-channel feed (`https://tavrn.org/updates/desktop/<channel>/latest.json`): a
//! redirect to the `latest.json` of the right GitHub release (GitHub's own "latest" never points at a pre-release).
//! The channel is a setting (`config.rs`): `beta` by default when this version is a pre-release, else `stable`; the
//! updater only ever offers a higher version (semantic versions: 0.4.0 > 0.4.0-rc.4), so switching to stable from a
//! pre-release waits for the next release instead of going back. Failures reach the client as one of four codes.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The value tauri.conf.json carries until the owner's public key replaces it.
pub const PLACEHOLDER: &str = "REPLACE_WITH_THE_OWNERS_MINISIGN_PUBLIC_KEY";

/// Base64 of "untrusted comment:", the start of every key `tauri signer generate` writes.
const KEY_PREFIX: &str = "dW50cnVzdGVkIGNvbW1lbnQ6";

/// Where the website serves the update feeds, one directory per channel.
pub const FEED_BASE: &str = "https://tavrn.org/updates/desktop";

/// Development builds only: another feed host (a local website with a fake GitHub API), e.g.
/// `TAVRN_UPDATE_BASE=http://127.0.0.1:18089/updates/desktop`. Release builds ignore it.
pub const BASE_ENV: &str = "TAVRN_UPDATE_BASE";

/// The update server could not be reached (no network, DNS, TLS, timeout, or it has no release list right now).
pub const UNREACHABLE: &str = "update.unreachable";
/// The chosen channel has no release (the website's 404 `no_release`).
pub const NO_RELEASE: &str = "update.no_release";
/// The download is not signed with this app's update key.
pub const SIGNATURE_INVALID: &str = "update.signature_invalid";
/// Anything else (logged with its reason).
pub const FAILED: &str = "update.failed";

/// What a request of the updater is for: its timeout ([`timeout_of`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Settings → App asks for the newest release: a stalled connection (a captive portal, a proxy that never answers)
    /// must not leave it spinning.
    Check,
    /// The check again and the download of the installer (tens of megabytes on a slow line).
    Install,
}

/// The timeout of the updater's requests (the plugin applies one timeout per request, the download included).
pub fn timeout_of(purpose: Purpose) -> Duration {
    match purpose {
        Purpose::Check => Duration::from_secs(30),
        Purpose::Install => Duration::from_secs(30 * 60),
    }
}

/// The update channel: `stable` offers releases only, `beta` pre-releases too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "stable" => Some(Self::Stable),
            "beta" => Some(Self::Beta),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    /// Without a choice: a pre-release (`-rc.`, `-beta.`) follows beta, a release stable.
    pub fn default_for(version: &str) -> Self {
        if version.contains("-rc.") || version.contains("-beta.") { Self::Beta } else { Self::Stable }
    }

    /// The stored choice when there is a valid one, else the default for this version.
    pub fn effective(stored: Option<&str>, version: &str) -> Self {
        stored.and_then(Self::parse).unwrap_or_else(|| Self::default_for(version))
    }
}

/// The feed host: `FEED_BASE`, or in a development build a valid `TAVRN_UPDATE_BASE` (http or https, no query).
pub fn feed_base(dev_override: Option<&str>) -> String {
    dev_override
        .map(|b| b.trim().trim_end_matches('/'))
        .filter(|b| {
            tauri::Url::parse(b).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some() && u.query().is_none() && u.fragment().is_none())
        })
        .map_or_else(|| FEED_BASE.to_string(), str::to_string)
}

/// The feed host of this build (the override only in a development build).
pub fn base() -> String {
    if cfg!(debug_assertions) { feed_base(std::env::var(BASE_ENV).ok().as_deref()) } else { FEED_BASE.to_string() }
}

/// The Tauri updater's feed of a channel.
pub fn endpoint(base: &str, channel: Channel) -> String {
    format!("{}/{}/latest.json", base.trim_end_matches('/'), channel.as_str())
}

/// The client's code for an updater error, or `None` for "no valid release JSON" (`ReleaseNotFound`: the feed did
/// not answer 200), which only the feed's own answer explains ([`code_of_answer`]).
#[cfg(desktop)]
pub fn code_of(e: &tauri_plugin_updater::Error) -> Option<&'static str> {
    use tauri_plugin_updater::Error as E;
    Some(match e {
        E::ReleaseNotFound => return None,
        // The feed was not JSON (a captive portal's page, a proxy's error page).
        E::Reqwest(e) if e.is_decode() => FAILED,
        E::Reqwest(_) => UNREACHABLE,
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => SIGNATURE_INVALID,
        // The channel's release has no build for this platform (a release without the Windows installers).
        E::TargetNotFound(_) | E::TargetsNotFound(_) => NO_RELEASE,
        _ => FAILED,
    })
}

/// What the feed's own answer says after the updater found no release JSON: the website's 404 `no_release`, its 503
/// or another server error (no release list right now), no answer at all, or something else.
pub fn code_of_answer(answer: Result<&crate::resolve::Fetched, crate::resolve::FetchError>) -> &'static str {
    #[derive(Deserialize)]
    struct Problem {
        error: String,
    }
    match answer {
        Err(crate::resolve::FetchError::Transport) => UNREACHABLE,
        Err(crate::resolve::FetchError::Refused) => FAILED,
        Ok(f) if f.status == 404 && serde_json::from_slice::<Problem>(&f.body).is_ok_and(|p| p.error == "no_release") => NO_RELEASE,
        Ok(f) if f.status >= 500 => UNREACHABLE,
        Ok(_) => FAILED,
    }
}

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

    #[test]
    fn every_updater_request_has_a_timeout() {
        // A check gives up like the Electron shell's (30 s); an installer download may take longer but not forever.
        assert_eq!(timeout_of(Purpose::Check), Duration::from_secs(30));
        assert!(timeout_of(Purpose::Install) > timeout_of(Purpose::Check));
        assert!(timeout_of(Purpose::Install) <= Duration::from_secs(3600));
    }

    /// A throwaway public key from `tauri signer generate` (its private key was never committed or used for releases).
    const SAMPLE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJCQkEyNjMwMjRDNTZCMDcKUldRSGE4VWtNQ2E2SzJqdGNjcGR6NUFYTUlIUDVveHZYMlhDZWpyTGxhMVVLM0J5T2FRbVNiR3YK";

    #[test]
    fn a_real_key_enables_updates() {
        assert!(pubkey_configured(SAMPLE));
        assert!(configured(Some(&json!({ "pubkey": SAMPLE, "endpoints": [endpoint(FEED_BASE, Channel::Stable)] }))));
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
    #[test]
    fn the_feed_of_each_channel_on_the_website() {
        assert_eq!(endpoint(FEED_BASE, Channel::Stable), "https://tavrn.org/updates/desktop/stable/latest.json");
        assert_eq!(endpoint(FEED_BASE, Channel::Beta), "https://tavrn.org/updates/desktop/beta/latest.json");
        assert_eq!(endpoint("http://127.0.0.1:18089/updates/desktop/", Channel::Beta), "http://127.0.0.1:18089/updates/desktop/beta/latest.json");
    }

    #[test]
    fn a_development_override_of_the_feed_host_must_be_a_plain_web_url() {
        assert_eq!(feed_base(None), FEED_BASE);
        assert_eq!(feed_base(Some(" http://127.0.0.1:18089/updates/desktop/ ")), "http://127.0.0.1:18089/updates/desktop");
        assert_eq!(feed_base(Some("https://feeds.example/desktop")), "https://feeds.example/desktop");
        for bad in
            ["", "file:///etc/passwd", "ftp://x.example/u", "https://x.example/u?channel=beta", "https://x.example/u#f", "not a url", "javascript:alert(1)"]
        {
            assert_eq!(feed_base(Some(bad)), FEED_BASE, "{bad}");
        }
    }

    #[test]
    fn the_default_channel_follows_the_version_and_a_choice_sticks() {
        assert_eq!(Channel::default_for("0.4.0-rc.4"), Channel::Beta);
        assert_eq!(Channel::default_for("0.5.0-beta.1"), Channel::Beta);
        assert_eq!(Channel::default_for("0.4.0"), Channel::Stable);
        assert_eq!(Channel::default_for("1.2.3"), Channel::Stable);
        assert_eq!(Channel::effective(None, "0.4.0-rc.4"), Channel::Beta);
        assert_eq!(Channel::effective(Some("stable"), "0.4.0-rc.4"), Channel::Stable, "an explicit choice sticks");
        assert_eq!(Channel::effective(Some("beta"), "0.4.0"), Channel::Beta);
        assert_eq!(Channel::effective(Some("nightly"), "0.4.0"), Channel::Stable, "an unknown value means no choice");
        assert_eq!(Channel::parse("Beta"), None);
        assert_eq!(serde_json::to_value(Channel::Beta).ok(), Some(json!("beta")));
    }

    #[test]
    fn only_higher_versions_are_offered_and_a_release_is_higher_than_its_candidates() {
        // The updater offers `remote > current` (tauri-plugin-updater's default comparison on semver::Version):
        // switching from a pre-release to stable waits for the release instead of going back.
        let v = |s: &str| semver::Version::parse(s).ok();
        assert!(v("0.4.0") > v("0.4.0-rc.4"));
        assert!(v("0.4.0-rc.10") > v("0.4.0-rc.4"), "numeric identifiers compare as numbers");
        assert!(v("0.4.0-rc.4") > v("0.3.9"));
        assert!(v("0.3.9") < v("0.4.0-rc.4"), "an older stable release is never offered to a newer pre-release");
        assert!(v("0.4.0-rc.1") < v("0.4.0-rc.4"));
    }

    #[test]
    fn the_feeds_answer_explains_a_missing_release() {
        use crate::resolve::{FetchError, Fetched};
        let answer = |status: u16, body: &str| Fetched { status, body: body.as_bytes().to_vec() };
        assert_eq!(code_of_answer(Ok(&answer(404, r#"{"error":"no_release","channel":"stable"}"#))), NO_RELEASE);
        assert_eq!(code_of_answer(Ok(&answer(503, r#"{"error":"unavailable","channel":"beta"}"#))), UNREACHABLE);
        assert_eq!(code_of_answer(Ok(&answer(502, "Bad gateway"))), UNREACHABLE);
        assert_eq!(code_of_answer(Ok(&answer(404, "<h1>Not found</h1>"))), FAILED, "a 404 that is not the website's");
        assert_eq!(code_of_answer(Ok(&answer(200, "{}"))), FAILED);
        assert_eq!(code_of_answer(Err(FetchError::Transport)), UNREACHABLE);
        assert_eq!(code_of_answer(Err(FetchError::Refused)), FAILED, "a redirect to GitHub that the updater could not read");
    }

    #[cfg(desktop)]
    #[test]
    fn updater_errors_become_the_clients_codes() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(code_of(&E::ReleaseNotFound), None, "the feed's answer decides");
        assert_eq!(code_of(&E::MissingSignedVersion), Some(SIGNATURE_INVALID));
        assert_eq!(code_of(&E::SignedVersionMismatch { signed: "1.0.0".into(), announced: "2.0.0".into() }), Some(SIGNATURE_INVALID));
        assert_eq!(code_of(&E::SignatureUtf8("x".into())), Some(SIGNATURE_INVALID));
        assert_eq!(code_of(&E::Network("Download request failed with status: 404".into())), Some(FAILED));
        assert_eq!(code_of(&E::TargetNotFound("windows-x86_64".into())), Some(NO_RELEASE), "no build for this platform in the channel");
        assert_eq!(code_of(&E::TargetsNotFound(vec!["linux-x86_64".into()])), Some(NO_RELEASE));
        assert_eq!(code_of(&E::Io(std::io::Error::other("disk full"))), Some(FAILED));
    }
}
