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

fn mobile_capability() -> Value {
    serde_json::from_str(include_str!("../capabilities/mobile.json")).unwrap_or_else(|e| unreachable!("mobile.json: {e}"))
}

fn android_conf() -> Value {
    serde_json::from_str(include_str!("../tauri.android.conf.json")).unwrap_or_else(|e| unreachable!("tauri.android.conf.json: {e}"))
}

fn permissions(cap: &Value) -> Vec<&str> {
    cap["permissions"].as_array().map(|p| p.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

/// The commands build.rs gives permissions to (its `commands` list).
fn manifest_commands() -> Vec<String> {
    let build = include_str!("../build.rs");
    let list = &build[build.find("let commands = &[").unwrap_or_else(|| unreachable!("build.rs: commands"))..];
    let list = &list[..list.find("];").unwrap_or(list.len())];
    list.lines().filter_map(|l| l.trim().strip_prefix('"').and_then(|l| l.strip_suffix("\",")).map(str::to_string)).collect()
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
            "allow-get-update-channel",
            "allow-set-update-channel",
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
            "allow-passkey-create",
            "allow-passkey-get",
            "allow-games-watch",
        ]
    );
    // Downloads: the shell opens the save dialog and writes the file itself; the dialog, opener and fs plugins stay
    // out of the webview's reach.
    assert!(permissions.iter().all(|p| p.starts_with("allow-")), "no plugin or core permissions: the shell's own commands only");
    assert_eq!(cap["platforms"], serde_json::json!(["linux", "macOS", "windows"]), "the desktop's commands only on the desktop");
    assert_eq!(conf()["app"]["security"]["capabilities"], serde_json::json!(["main", "mobile"]));
}

#[test]
fn the_android_capability_grants_only_the_app_commands_of_the_android_app() {
    let cap = mobile_capability();
    assert_eq!(cap["windows"], serde_json::json!([crate::MAIN_WINDOW]));
    assert_eq!(cap["platforms"], serde_json::json!(["android"]));
    assert!(cap.get("remote").is_none(), "no remote origin may call the shell");
    let granted = permissions(&cap);
    assert_eq!(
        granted,
        [
            "allow-get-config",
            "allow-set-node",
            "allow-app-info",
            "allow-open-external",
            "allow-resolve-node",
            "allow-get-update-channel",
            "allow-set-update-channel",
            "allow-open-connect",
            "allow-close-connect",
            "allow-notify",
            "allow-shell-events",
            "allow-android-info",
            "allow-android-permission",
            "allow-android-open-settings",
            "allow-android-battery-exemption",
            "allow-android-voice",
            "allow-android-background",
            "allow-android-push-register",
            "allow-android-push-unregister",
            "allow-android-push-config",
            "allow-android-keep-connection",
            "allow-android-check-update",
            "allow-android-save-begin",
            "allow-android-save-chunk",
            "allow-android-save-end",
            "allow-android-save-abort",
            "allow-android-audio-routes",
            "allow-android-audio-route",
            "allow-android-orientation",
            "allow-android-unlock-status",
            "allow-android-unlock-store",
            "allow-android-unlock-get",
            "allow-android-unlock-clear",
            "allow-android-screen-share-start",
            "allow-android-screen-share-key",
            "allow-android-screen-share-stop",
            "allow-android-screen-share-status",
            "allow-passkey-create",
            "allow-passkey-get",
        ]
    );
    // Only the app's own commands: the Kotlin plugin (`plugin:tavrn-android|…`) and every other plugin stay out of
    // the webview's reach, so the Kotlin side is reached only through android.rs's checked commands.
    assert!(granted.iter().all(|p| p.starts_with("allow-") && !p.contains(':')));
    // No desktop-only command (keychain, tray, hotkeys, downloads, native voice, updater) on Android.
    for desktop_only in ["keychain", "tray", "hotkey", "save-file", "allow-voice-", "install-update", "quit"] {
        assert!(!granted.iter().any(|p| p.contains(desktop_only)), "{desktop_only} granted on Android");
    }
    assert!(!granted.contains(&"allow-check-update"), "Tauri's updater has no Android support");
}

#[test]
fn every_granted_permission_is_a_command_of_the_manifest() {
    let commands = manifest_commands();
    assert!(commands.len() > 40, "build.rs lists {commands:?}");
    for cap in [capability(), mobile_capability()] {
        for permission in permissions(&cap) {
            let command = permission.trim_start_matches("allow-").replace('-', "_");
            assert!(commands.contains(&command), "{permission} names no command of build.rs");
        }
    }
    let android_commands = commands.iter().filter(|c| c.starts_with("android_")).count();
    assert_eq!(android_commands, permissions(&mobile_capability()).iter().filter(|p| p.starts_with("allow-android-")).count());
}

#[test]
fn the_android_app_has_its_own_identifier_and_minimum_version() {
    let c = android_conf();
    assert_eq!(c["identifier"], "org.tavrn.app", "never the desktop's org.tavrn.desktop");
    assert_ne!(c["identifier"], conf()["identifier"]);
    assert_eq!(c["bundle"]["android"]["minSdkVersion"], 26, "docs/ANDROID.md \"Which Android versions\"");
    let gradle = include_str!("../gen/android/app/build.gradle.kts");
    for line in ["applicationId = \"org.tavrn.app\"", "minSdk = 26", "targetSdk = 36"] {
        assert!(gradle.contains(line), "build.gradle.kts lacks {line}");
    }
}

#[test]
fn the_android_manifest_keeps_its_promises() {
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    // Plain http only for a development node on the device itself, no backups of the key store.
    assert!(manifest.contains("android:networkSecurityConfig=\"@xml/network_security_config\""));
    assert!(!manifest.contains("usesCleartextTraffic"));
    assert!(manifest.contains("android:allowBackup=\"false\""));
    let network = include_str!("../gen/android/app/src/main/res/xml/network_security_config.xml");
    assert!(network.contains("<base-config cleartextTrafficPermitted=\"false\" />"));
    // Every service and receiver of the app is private (the connector's own receiver is the only door for pushes).
    for component in ["\".VoiceService\"", "\".ConnectionService\"", "\".PushReceiver\"", "\".ActionReceiver\""] {
        let at = manifest.find(component).unwrap_or_else(|| unreachable!("{component} missing"));
        let tag = &manifest[..at];
        let start = tag.rfind('<').unwrap_or(0);
        let element = &manifest[start..manifest[at..].find('>').map_or(manifest.len(), |e| at + e)];
        assert!(element.contains("android:exported=\"false\""), "{component} is exported");
    }
    // App links only for the paths the shell accepts (mobile::app_link).
    assert!(manifest.contains("android:autoVerify=\"true\""));
    for host in crate::mobile::APP_LINK_HOSTS {
        assert!(manifest.contains(&format!("android:host=\"{host}\"")), "{host} has no intent filter");
    }
    // The `tavrn://` scheme (deeplink.rs) opens the app, in its own intent filter without autoVerify.
    let scheme = format!("<data android:scheme=\"{}\" />", crate::deeplink::SCHEME);
    let at = manifest.find(&scheme).unwrap_or_else(|| unreachable!("no intent filter for {scheme}"));
    let filter = &manifest[manifest[..at].rfind("<intent-filter").unwrap_or(0)..at];
    assert!(filter.contains("android.intent.action.VIEW") && filter.contains("android.intent.category.BROWSABLE") && !filter.contains("autoVerify"));
    // No Google services: no Firebase, no Play services anywhere in the Android project.
    let gradle = include_str!("../gen/android/app/build.gradle.kts");
    for google in ["firebase", "play-services", "gms"] {
        assert!(!gradle.contains(google) && !manifest.contains(google), "{google} in the Android app");
    }
}

/// The libraries the Android app declares and their licences (docs/ANDROID.md "Libraries and licences" lists them with
/// their own dependencies): a new one needs a line here and there, with a licence of the project's allow-list.
const ANDROID_LIBRARIES: [(&str, &str); 10] = [
    ("androidx.webkit:webkit", "Apache-2.0"),
    ("androidx.appcompat:appcompat", "Apache-2.0"),
    ("androidx.activity:activity-ktx", "Apache-2.0"),
    ("com.google.android.material:material", "Apache-2.0"),
    ("androidx.lifecycle:lifecycle-process", "Apache-2.0"),
    ("androidx.browser:browser", "Apache-2.0"),
    ("org.unifiedpush.android:connector", "Apache-2.0"),
    ("androidx.credentials:credentials", "Apache-2.0"),
    ("io.livekit:livekit-android", "Apache-2.0"),
    ("org.jetbrains.kotlinx:kotlinx-coroutines-android", "Apache-2.0"),
];

#[test]
fn the_android_libraries_are_listed_with_their_licences() {
    let gradle = include_str!("../gen/android/app/build.gradle.kts");
    let docs = include_str!("../../../../docs/ANDROID.md");
    let allowed = ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC"];
    let declared: Vec<&str> = gradle
        .lines()
        .filter_map(|l| l.trim().strip_prefix("implementation(\""))
        .filter_map(|l| l.split('"').next())
        .map(|coordinate| coordinate.rsplit_once(':').map_or(coordinate, |(lib, _version)| lib))
        .collect();
    assert_eq!(declared.len(), ANDROID_LIBRARIES.len(), "build.gradle.kts declares {declared:?}");
    for lib in &declared {
        let licence = ANDROID_LIBRARIES.iter().find(|(name, _)| name == lib).map(|(_, l)| *l);
        assert!(licence.is_some_and(|l| allowed.contains(&l)), "{lib} is not on the licence list");
        assert!(docs.contains(&format!("`{lib}`")), "docs/ANDROID.md does not list {lib}");
    }
    // JitPack serves the one group the LiveKit SDK needs from there, nothing else.
    let root = include_str!("../gen/android/build.gradle.kts");
    assert_eq!(root.matches("maven(").count(), 1);
    assert!(root.contains("includeGroup(\"com.github.davidliu\")"));
    // The screen share's service comes with the SDK; the app names its permission and no service of its own type.
    let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
    assert!(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"));
}

#[test]
fn deep_links_are_the_tavrn_scheme_only() {
    // The installers (Windows registry, the macOS bundle) register exactly the scheme deeplink.rs accepts; the plugin
    // needs no permission in any capability (the shell hands links to the client as shell events).
    let c = conf();
    assert_eq!(c["plugins"]["deep-link"]["desktop"]["schemes"], serde_json::json!([crate::deeplink::SCHEME]));
    assert!(c["plugins"]["deep-link"].get("mobile").is_none(), "Android: the manifest's intent filters");
    for cap in [capability(), mobile_capability()] {
        assert!(!permissions(&cap).iter().any(|p| p.starts_with("deep-link")), "{:?}", permissions(&cap));
    }
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
fn updates_come_from_the_websites_channel_feeds_and_are_signed() {
    let c = conf();
    let plugin = &c["plugins"]["updater"];
    // The shell sets the endpoint of the chosen channel at every check (commands.rs); the configured one is stable's.
    assert_eq!(plugin["endpoints"], serde_json::json!([updater::endpoint(updater::FEED_BASE, updater::Channel::Stable)]));
    assert!(plugin.get("dangerousInsecureTransportProtocol").is_none(), "https only in release builds");
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
