// SPDX-License-Identifier: Apache-2.0
//! The app's settings in `<app config dir>/config.json` (Linux `~/.config/org.tavrn.desktop/`, Windows
//! `%APPDATA%\org.tavrn.desktop\`): the home node chosen in the node picker, with its identity domain and the origin
//! of its web client when they are known (delegation: both may differ from the node's URL), and "close to tray". A
//! missing, unreadable or corrupt file means "no settings" (the node picker asks again); a stored node that no longer
//! passes the validation is dropped.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::node_url;

pub const FILE_NAME: &str = "config.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    /// Origin of the home node, or none before the first choice.
    #[serde(default)]
    pub node: Option<String>,
    /// Origin of the node's web client (its sign-in page), when its document named one.
    #[serde(default)]
    pub web: Option<String>,
    /// Identity domain of the node (`alice@<domain>`), when known.
    #[serde(default)]
    pub domain: Option<String>,
    /// Closing the window hides it into the tray; none: the platform's default (`tray::close_to_tray_default`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_to_tray: Option<bool>,
}

/// An identity domain worth storing: a node domain, or `localhost` (a development node).
pub fn valid_identity_domain(d: &str) -> bool {
    d == "localhost" || crate::resolve::valid_domain(d)
}

/// Reads the settings; never fails (see the module documentation).
pub fn load(path: &Path) -> Config {
    let Ok(text) = fs::read_to_string(path) else {
        return Config::default();
    };
    let Ok(mut config) = serde_json::from_str::<Config>(&text) else {
        eprintln!("tavrn: ignoring the corrupt settings file {}", path.display());
        return Config::default();
    };
    config.node = config.node.and_then(|n| node_url::validate(&n).ok());
    // The web origin and the domain belong to the node: without it they mean nothing.
    config.web = config.web.filter(|_| config.node.is_some()).and_then(|w| node_url::validate(&w).ok());
    config.domain = config.domain.filter(|d| config.node.is_some() && valid_identity_domain(d));
    config
}

/// Writes the settings atomically (temporary file, then rename), creating the directory.
pub fn save(path: &Path, config: &Config) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(config).map_err(io::Error::other)?;
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh directory per test (no extra crate for temporary directories).
    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tavrn-desktop-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn missing_file_means_no_node() {
        let d = dir("missing");
        assert_eq!(load(&d.join(FILE_NAME)), Config::default());
    }

    #[test]
    fn writes_and_reads_the_node() -> io::Result<()> {
        let d = dir("roundtrip");
        let path = d.join("nested").join(FILE_NAME);
        let config = Config {
            node: Some("https://tavrn.example".into()),
            web: Some("https://web.tavrn.example".into()),
            domain: Some("tavrn.example".into()),
            close_to_tray: Some(true),
        };
        save(&path, &config)?;
        assert_eq!(load(&path), config);
        assert!(!path.with_extension("json.tmp").exists(), "no temporary file is left behind");
        save(&path, &Config::default())?;
        assert_eq!(load(&path), Config::default());
        fs::remove_dir_all(d)
    }

    #[test]
    fn corrupt_file_means_no_node() -> io::Result<()> {
        let d = dir("corrupt");
        fs::create_dir_all(&d)?;
        let path = d.join(FILE_NAME);
        for text in ["{not json", "", "[]", "{\"node\": 42}"] {
            fs::write(&path, text)?;
            assert_eq!(load(&path), Config::default(), "{text}");
        }
        fs::remove_dir_all(d)
    }

    #[test]
    fn a_stored_node_that_fails_validation_is_dropped() -> io::Result<()> {
        let d = dir("invalid");
        fs::create_dir_all(&d)?;
        let path = d.join(FILE_NAME);
        fs::write(&path, r#"{"node": "http://evil.example"}"#)?;
        assert_eq!(load(&path).node, None);
        fs::write(&path, r#"{"node": "https://Tavrn.Example/", "future": true}"#)?;
        assert_eq!(load(&path).close_to_tray, None, "an older file has no close-to-tray choice");
        assert_eq!(load(&path).node.as_deref(), Some("https://tavrn.example"), "normalized; unknown fields ignored");
        fs::write(&path, r#"{"node": "https://tavrn.example", "web": "http://evil.example", "domain": "Not A Domain"}"#)?;
        let c = load(&path);
        assert_eq!((c.web, c.domain), (None, None), "an invalid web origin or domain is dropped");
        fs::write(&path, r#"{"web": "https://web.tavrn.example", "domain": "tavrn.example"}"#)?;
        assert_eq!(load(&path), Config::default(), "nothing without a node");
        fs::remove_dir_all(d)
    }
}
