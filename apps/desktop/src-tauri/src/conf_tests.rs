// SPDX-License-Identifier: Apache-2.0
//! Checks of tauri.conf.json and the capability: the security properties of docs/DESKTOP.md must not erode.

use serde_json::Value;

use crate::{guard, updater};

fn conf() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).unwrap_or_else(|e| unreachable!("tauri.conf.json: {e}"))
}

fn capability() -> Value {
    serde_json::from_str(include_str!("../capabilities/main.json")).unwrap_or_else(|e| unreachable!("main.json: {e}"))
}

fn csp(directive: &str) -> Vec<String> {
    conf()["app"]["security"]["csp"][directive]
        .as_str()
        .unwrap_or_else(|| unreachable!("CSP has no {directive}"))
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

#[test]
fn scripts_come_only_from_the_bundle() {
    assert_eq!(csp("script-src"), ["'self'", "'wasm-unsafe-eval'"], "no remote scripts, no eval, no inline scripts");
    assert_eq!(csp("default-src"), ["'self'"]);
    assert_eq!(csp("object-src"), ["'none'"]);
    assert_eq!(csp("base-uri"), ["'self'"]);
    assert_eq!(csp("worker-src"), ["'self'", "blob:"]);
}

#[test]
fn the_client_reaches_any_node_over_https_and_wss_and_dev_nodes_on_this_computer() {
    let connect = csp("connect-src");
    for needed in ["'self'", "ipc:", "http://ipc.localhost", "https:", "wss:"] {
        assert!(connect.contains(&needed.to_string()), "connect-src lacks {needed}");
    }
    for plain in connect.iter().filter(|s| s.starts_with("http://") || s.starts_with("ws://")) {
        assert!(
            ["http://ipc.localhost", "http://localhost:*", "ws://localhost:*", "http://127.0.0.1:*", "ws://127.0.0.1:*"].contains(&plain.as_str()),
            "plain-text source {plain} is not this computer"
        );
    }
    assert!(!connect.contains(&"http:".to_string()) && !connect.contains(&"ws:".to_string()));
}

#[test]
fn frames_only_the_embed_providers() {
    let expected: Vec<String> = guard::EMBED_HOSTS.iter().map(|h| format!("https://{h}")).collect();
    assert_eq!(csp("frame-src"), expected);
}

#[test]
fn the_window_shows_only_the_bundle() {
    let c = conf();
    assert_eq!(c["build"]["frontendDist"], "../../../web/dist", "the app bundles the web client");
    let windows = c["app"]["windows"].as_array().cloned().unwrap_or_default();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], crate::MAIN_WINDOW);
    assert_eq!(windows[0]["create"], false, "created in setup() with the navigation guard");
    assert!(windows[0].get("url").is_none(), "no remote URL");
    assert_eq!(c["app"]["withGlobalTauri"], false);
}

#[test]
fn the_capability_grants_only_the_app_commands_to_the_main_window() {
    let cap = capability();
    assert_eq!(cap["windows"], serde_json::json!([crate::MAIN_WINDOW]));
    assert!(cap.get("remote").is_none(), "no remote origin may call the shell");
    let permissions: Vec<&str> = cap["permissions"].as_array().map(|p| p.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    assert_eq!(
        permissions,
        [
            "allow-get-config",
            "allow-set-node",
            "allow-app-info",
            "allow-open-external",
            "allow-check-update",
            "allow-install-update",
            "allow-resolve-node",
            "allow-open-connect",
            "allow-close-connect",
            "allow-keychain-get",
            "allow-keychain-set",
            "allow-keychain-delete",
            "allow-keychain-status",
            "allow-notify",
            "allow-shell-events",
            "allow-tray-set",
            "allow-tray-status",
            "allow-set-close-to-tray",
            "allow-quit-app",
            "allow-register-hotkey",
            "allow-unregister-hotkey",
            "allow-listen-hotkeys",
            "allow-set-hotkeys-enabled",
            "allow-save-file-begin",
            "allow-save-file-chunk",
            "allow-save-file-end",
            "allow-save-file-abort",
            "allow-save-file-reveal",
            "allow-voice-info",
            "allow-voice-devices",
            "allow-voice-join",
            "allow-voice-leave",
            "allow-voice-set-key",
            "allow-voice-set-muted",
            "allow-voice-set-deafened",
            "allow-voice-set-ptt",
            "allow-voice-configure",
            "allow-voice-set-volumes",
        ]
    );
    // Downloads: the shell opens the save dialog and writes the file itself; the dialog, opener and fs plugins stay
    // out of the webview's reach.
    assert!(permissions.iter().all(|p| p.starts_with("allow-")), "no plugin or core permissions: the shell's own commands only");
    assert_eq!(conf()["app"]["security"]["capabilities"], serde_json::json!(["main"]));
}

#[test]
fn no_capability_reaches_the_sign_in_window() {
    // Every capability file of the shell: none may name the sign-in window (or every window), so the node's page and
    // the identity providers shown there never reach a native command.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut files = 0;
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| unreachable!("{e}")).flatten() {
        let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
        let cap: Value = serde_json::from_str(&text).unwrap_or_else(|e| unreachable!("{}: {e}", entry.path().display()));
        files += 1;
        let windows: Vec<&str> = cap["windows"].as_array().map(|w| w.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        assert!(!windows.iter().any(|w| *w == crate::CONNECT_WINDOW || w.contains('*')), "{} names {windows:?}", entry.path().display());
        assert!(cap.get("webviews").is_none() && cap.get("remote").is_none(), "{}", entry.path().display());
    }
    assert!(files >= 1);
    assert_ne!(crate::CONNECT_WINDOW, crate::MAIN_WINDOW);
}

#[test]
fn the_sign_in_window_denies_downloads_and_permissions() {
    let url = tauri::Url::parse("https://node.example/file.exe").unwrap_or_else(|e| unreachable!("{e}"));
    assert!(!crate::connect_download(&url));
    for kind in [
        tauri::webview::PermissionKind::Microphone,
        tauri::webview::PermissionKind::Camera,
        tauri::webview::PermissionKind::Geolocation,
        tauri::webview::PermissionKind::Notifications,
    ] {
        assert!(matches!(crate::connect_permission(kind), tauri::webview::PermissionResponse::Deny));
    }
    // Both handlers are installed on the sign-in window.
    let lib = include_str!("lib.rs");
    let window = &lib[lib.find("pub fn open_connect_window").unwrap_or_else(|| unreachable!("open_connect_window"))..];
    let window = &window[..window.find("\n}\n").unwrap_or(window.len())];
    for handler in [".on_download(", ".on_permission_request(", "connect_download(", "connect_permission("] {
        assert!(window.contains(handler), "open_connect_window lacks {handler}");
    }
}

#[test]
fn version_and_identity() {
    let c = conf();
    assert_eq!(c["version"], "../../../web/package.json", "one version number: the web client's");
    // The installers keep the capitalised product name (file names like Tavrn_<version>_x64-setup.exe, the Windows
    // start menu); everything the app shows says "tavrn" in lowercase.
    assert_eq!(c["productName"], "Tavrn");
    assert_eq!(c["app"]["windows"][0]["title"], "tavrn");
    assert_eq!(c["identifier"], "org.tavrn.desktop");
}

#[test]
fn updates_come_from_the_github_releases_and_are_signed() {
    let c = conf();
    let plugin = &c["plugins"]["updater"];
    assert_eq!(plugin["endpoints"], serde_json::json!([updater::ENDPOINT]));
    let key = plugin["pubkey"].as_str().unwrap_or_default();
    assert!(key == updater::PLACEHOLDER || updater::pubkey_configured(key), "the pubkey is the owner's key or the marked placeholder");
    assert_eq!(c["bundle"]["createUpdaterArtifacts"], false, "updater artifacts only in the tagged release build (desktop.yml)");
}

#[test]
fn installers_for_windows_only() {
    // Linux ships the Electron shell (docs/DESKTOP.md "Builds and releases"): no Tauri .deb or AppImage, and no Linux
    // package settings that would suggest one.
    let c = conf();
    assert_eq!(c["bundle"]["targets"], serde_json::json!(["msi", "nsis"]));
    assert!(c["bundle"]["linux"].is_null(), "no Linux bundle settings");
}

#[test]
fn the_installers_show_the_licence_and_terms() {
    let c = conf();
    assert_eq!(c["bundle"]["licenseFile"], "../LICENSE.txt", "NSIS shows it as the licence page to accept, the MSI as its licence dialog");
    let text = include_str!("../../LICENSE.txt");
    assert!(text.len() > 10_000, "the licence file is the Apache-2.0 text, the NOTICE and the terms");
    for part in ["Apache License", "Version 2.0, January 2004", "Terms of use and privacy notice for the tavrn desktop app", "https://tavrn.org", "github.com"]
    {
        assert!(text.contains(part), "LICENSE.txt lacks {part:?}");
    }
}

#[test]
fn the_icons_of_the_bundle_exist() {
    let icons = conf()["bundle"]["icon"].as_array().cloned().unwrap_or_default();
    assert!(icons.len() >= 5, "PNG sizes (the window; the Electron shell's Linux packages), .ico for Windows, .icns for macOS");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for icon in &icons {
        let path = dir.join(icon.as_str().unwrap_or_default());
        assert!(std::fs::metadata(&path).is_ok_and(|m| m.len() > 0), "missing icon {}", path.display());
    }
    for kind in [".png", ".ico", ".icns"] {
        assert!(icons.iter().any(|i| i.as_str().is_some_and(|i| i.ends_with(kind))), "no {kind} icon");
    }
}
