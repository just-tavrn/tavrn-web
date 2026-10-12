// SPDX-License-Identifier: Apache-2.0
//! The Android app's check for a new version (docs/ANDROID.md "Updates"): Tauri's updater does not support Android,
//! so the shell reads the release list of tavrn-web through the website's read-only proxy (`/gh/releases/web`, the
//! GitHub API's release objects) and names the newest release with a signed APK newer than this app; the client links
//! to it, the browser downloads it, Android installs it (the signature must match the installed app's). Read in Rust
//! because the proxy sends no CORS headers for the app's origin. Builds everywhere, so its tests run with the desktop's.

use serde::{Deserialize, Serialize};

/// The website's proxy of the tavrn-web releases.
pub const FEED: &str = "https://tavrn.org/gh/releases/web";
/// Where every release's assets are downloaded from.
const DOWNLOADS: &str = "https://github.com/just-tavrn/tavrn-web/releases/download/";
const MAX_FEED: usize = 2 * 1024 * 1024;

/// The APK of a version (`Tavrn_<version>_android-arm64.apk`, release-assets.mjs).
pub fn apk_name(version: &str) -> String {
    format!("Tavrn_{version}_android-arm64.apk")
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AvailableRelease {
    pub version: String,
    pub notes: Option<String>,
    /// The APK's download (always on GitHub's release downloads of tavrn-web).
    pub url: String,
}

/// The newest release newer than `current` that carries the APK (prereleases only for a prerelease app).
pub fn newest(feed: &[u8], current: &str) -> Option<AvailableRelease> {
    let current = semver::Version::parse(current).ok()?;
    let releases: Vec<Release> = serde_json::from_slice(feed).ok()?;
    releases
        .into_iter()
        .filter(|r| !r.draft && (!r.prerelease || !current.pre.is_empty()))
        .filter_map(|r| {
            let version = semver::Version::parse(r.tag_name.strip_prefix('v')?).ok()?;
            let name = apk_name(&version.to_string());
            let asset = r.assets.iter().find(|a| a.name == name)?;
            // Only GitHub's download of this very asset: the feed never sends the app elsewhere.
            let expected = format!("{DOWNLOADS}{}/{name}", r.tag_name);
            (asset.browser_download_url == expected && version > current).then_some((version, r.body, expected))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(version, notes, url)| AvailableRelease { version: version.to_string(), notes: notes.map(|n| n.chars().take(4000).collect()), url })
}

/// Reads the feed (at most 2 MiB).
pub async fn fetch(version: &str) -> Result<Option<AvailableRelease>, String> {
    let fetcher = crate::resolve::HttpFetcher::new(version)?;
    let body = fetcher.get_capped(FEED, MAX_FEED).await.map_err(|_| "update.unreachable".to_string())?;
    Ok(newest(&body, version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, prerelease: bool, apk: bool) -> serde_json::Value {
        let v = tag.trim_start_matches('v');
        let mut assets =
            vec![json!({ "name": format!("Tavrn_{v}_x64-setup.exe"), "browser_download_url": format!("{DOWNLOADS}{tag}/Tavrn_{v}_x64-setup.exe") })];
        if apk {
            assets.push(json!({ "name": apk_name(v), "browser_download_url": format!("{DOWNLOADS}{tag}/{}", apk_name(v)) }));
        }
        json!({ "tag_name": tag, "draft": false, "prerelease": prerelease, "body": "notes", "assets": assets })
    }

    fn feed(releases: &[serde_json::Value]) -> Vec<u8> {
        serde_json::to_vec(releases).unwrap_or_default()
    }

    #[test]
    fn the_newest_release_with_an_apk() {
        let f = feed(&[release("v0.6.0", false, false), release("v0.5.1", false, true), release("v0.5.0", false, true)]);
        let found = newest(&f, "0.5.0");
        assert_eq!(found.as_ref().map(|r| r.version.as_str()), Some("0.5.1"));
        assert_eq!(found.map(|r| r.url), Some(format!("{DOWNLOADS}v0.5.1/Tavrn_0.5.1_android-arm64.apk")));
        assert_eq!(newest(&f, "0.5.1"), None, "current");
    }

    #[test]
    fn prereleases_only_for_prerelease_apps() {
        let f = feed(&[release("v0.5.0-rc.2", true, true), release("v0.4.0", false, true)]);
        assert_eq!(newest(&f, "0.4.0"), None);
        assert_eq!(newest(&f, "0.5.0-rc.1").map(|r| r.version), Some("0.5.0-rc.2".into()));
        assert_eq!(newest(&f, "0.4.0-rc.2").map(|r| r.version), Some("0.5.0-rc.2".into()));
    }

    #[test]
    fn links_elsewhere_and_garbage_are_ignored() {
        let mut evil = release("v9.0.0", false, true);
        evil["assets"][1]["browser_download_url"] = json!("https://evil.example/Tavrn_9.0.0_android-arm64.apk");
        assert_eq!(newest(&feed(&[evil]), "0.4.0"), None);
        let mut draft = release("v9.0.0", false, true);
        draft["draft"] = json!(true);
        assert_eq!(newest(&feed(&[draft]), "0.4.0"), None);
        assert_eq!(newest(b"not json", "0.4.0"), None);
        assert_eq!(newest(&feed(&[release("latest", false, true)]), "0.4.0"), None);
    }
}
