// SPDX-License-Identifier: Apache-2.0
//! The platform-independent half of the Android app (docs/ANDROID.md): what the bundled client may hand the Kotlin
//! side (the voice notification, the texts of push notifications, the node's VAPID key, permission names, settings
//! pages) and what the Kotlin side may hand the client (app links, notification clicks, the voice notification's
//! buttons, the system bars and the keyboard, new push endpoints). Everything is checked here, in both directions,
//! with the same rules as the desktop shell's commands. This module compiles on every platform, so its tests run with
//! the desktop tests; `android.rs` is the bridge to the Kotlin plugin (`gen/android/.../ShellPlugin.kt`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::Url;

use crate::events::{ShellEvent, TrayAction};

/// Hosts whose https links open in the app (Android App Links: the host publishes `/.well-known/assetlinks.json`
/// with the app's signing certificate; docs/ANDROID.md "Links into the app").
pub const APP_LINK_HOSTS: [&str; 1] = ["app.tavrn.org"];
/// The fallback scheme: `tavrn://<host>/<path>` stands for `https://<host>/<path>` of any node.
pub const APP_SCHEME: &str = "tavrn";

const MAX_LINK: usize = 512;
const MAX_TEXT: usize = 200;
const MAX_PUSH_TEXT: usize = 300;

fn token(s: &str, min: usize) -> bool {
    (min..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A link the app opens (an App Link or a `tavrn://` link), as the https URL the client routes: only invite links
/// (`/invite/<code>`) and add links of applications (`/add/<id>`, `/add/<domain>/<id>`, optional `?room=`), on
/// a node's host without port or credentials. Everything else stays in the browser (the intent filters already name
/// only these paths; this is the second check).
pub fn app_link(input: &str) -> Option<String> {
    if input.len() > MAX_LINK {
        return None;
    }
    let url = Url::parse(input).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let known = match url.scheme() {
        "https" => APP_LINK_HOSTS.contains(&host.as_str()),
        APP_SCHEME => crate::resolve::valid_domain(&host),
        _ => false,
    };
    if !known || url.port().is_some() || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return None;
    }
    let segments: Vec<&str> = url.path().trim_start_matches('/').trim_end_matches('/').split('/').collect();
    let path_ok = match segments.as_slice() {
        ["invite", code] => token(code, 4),
        ["add", id] => token(id, 1),
        ["add", domain, id] => crate::resolve::valid_domain(domain) && token(id, 1),
        _ => false,
    };
    if !path_ok {
        return None;
    }
    let mut query = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "room" if segments[0] == "add" && query.is_none() && value.len() <= 200 && !value.chars().any(|c| c.is_control() || c.is_whitespace()) => {
                query = Some(value.into_owned());
            }
            _ => return None,
        }
    }
    let mut out = Url::parse(&format!("https://{host}/")).ok()?;
    out.set_path(&segments.join("/"));
    if let Some(room) = query {
        out.query_pairs_mut().append_pair("room", &room);
    }
    Some(out.to_string())
}

/// A path of the client a notification click opens (the rule of the desktop's notifications, `notify.rs`).
pub fn client_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && path.len() <= 512 && !path.chars().any(|c| c.is_control() || c == '\\' || c.is_whitespace())
}

fn text_ok(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}

/// The voice state the client reports (the tray's states of the desktop shell).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceState {
    Disconnected,
    Connected,
    Speaking,
    Muted,
    Deafened,
}

/// The persistent notification of the voice service while connected to a voice channel or call (docs/ANDROID.md
/// "Voice in the background"): its texts in the client's language and whether the camera is on (the service then
/// also has the camera type). `disconnected` stops the service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceNotice {
    pub state: VoiceState,
    /// "In voice channel Lounge (Gaming)".
    pub title: String,
    /// The state ("Muted", "Connected").
    pub text: String,
    pub mute: String,
    pub unmute: String,
    pub leave: String,
    #[serde(default)]
    pub camera: bool,
}

impl VoiceNotice {
    pub fn validate(&self) -> Result<(), &'static str> {
        let all = [&self.title, &self.text, &self.mute, &self.unmute, &self.leave];
        if all.iter().all(|s| text_ok(s, MAX_TEXT)) { Ok(()) } else { Err("android.invalid") }
    }

    /// Speaking flickers many times a second: the notification shows "connected" for it, so it is not rebuilt each time.
    pub fn shown_state(&self) -> VoiceState {
        if self.state == VoiceState::Speaking { VoiceState::Connected } else { self.state }
    }
}

/// The texts the native push receiver shows (the `push.sw.*` texts of the service worker) and the account's home node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushConfig {
    pub strings: BTreeMap<String, String>,
    #[serde(default)]
    pub home_node: Option<String>,
}

/// The keys of the push texts (`SW_STRING_KEYS` in web/src/lib/push.ts).
pub const PUSH_STRING_KEYS: [&str; 17] = [
    "app",
    "message",
    "message_anonymous",
    "mention",
    "mention_anonymous",
    "dm",
    "dm_encrypted",
    "call",
    "call_from",
    "remote_message",
    "remote_mention",
    "remote_dm",
    "test",
    "generic",
    "report_title",
    "report",
    "report_node",
];

impl PushConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        let strings_ok = self.strings.iter().all(|(k, v)| PUSH_STRING_KEYS.contains(&k.as_str()) && text_ok(v, MAX_PUSH_TEXT));
        let node_ok = self
            .home_node
            .as_deref()
            .is_none_or(|d| crate::config::valid_identity_domain(d) || d.split_once(':').is_some_and(|(h, p)| h == "localhost" && p.parse::<u16>().is_ok()));
        if strings_ok && node_ok { Ok(()) } else { Err("android.invalid") }
    }
}

/// The node's VAPID public key (RFC 8292): base64url of an uncompressed P-256 point, 65 bytes = 87 characters.
pub fn vapid_key(key: &str) -> Option<String> {
    let key = key.trim().trim_end_matches('=');
    (key.len() == 87 && key.starts_with('B') && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then(|| key.to_string())
}

/// A runtime permission the client asks for right before its first use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Notifications,
    Bluetooth,
    Microphone,
    Camera,
}

/// A page of the system settings the client may open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsPage {
    /// The app's page (permissions).
    App,
    /// The app's notification settings.
    Notifications,
    /// The list of battery optimisations.
    Battery,
}

/// A UnifiedPush endpoint with its RFC 8291 keys, as the node's push API takes it (PROTOCOL.md §6d).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushEndpoint {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

impl PushEndpoint {
    pub fn valid(&self) -> bool {
        let b64 = |s: &str, min: usize, max: usize| (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        let endpoint_ok =
            self.endpoint.len() <= 1024 && Url::parse(&self.endpoint).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some() && u.username().is_empty());
        endpoint_ok && b64(&self.p256dh, 86, 88) && b64(&self.auth, 22, 24)
    }
}

/// The system bars and the keyboard in CSS pixels (WindowInsets of the activity).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Insets {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
    /// The on-screen keyboard (0 when hidden); the WebView is already shortened by it.
    #[serde(default)]
    pub keyboard: f32,
}

impl Insets {
    fn valid(&self) -> bool {
        [self.top, self.right, self.bottom, self.left, self.keyboard].iter().all(|v| v.is_finite() && (0.0..=4096.0).contains(v))
    }
}

/// The name the save dialog suggests (Android's document picker): no path parts or control characters, at most 200
/// characters, never empty.
pub fn save_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() { "download".into() } else { clean }
}

/// A save's id as the Kotlin side made it (a UUID).
pub fn save_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// The largest piece of a save, in bytes of content.
pub const SAVE_CHUNK_BYTES: usize = 1024 * 1024;

/// A piece of a save as the client sends it: standard base64 of at most [`SAVE_CHUNK_BYTES`].
pub fn save_chunk(data: &str) -> bool {
    !data.is_empty()
        && data.len() <= SAVE_CHUNK_BYTES.div_ceil(3) * 4
        && data.len().is_multiple_of(4)
        && data.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
}

/// A MIME type the picker may be given (`type/subtype`, no parameters).
pub fn save_mime(mime: &str) -> String {
    let ok = mime.len() <= 100
        && mime
            .split_once('/')
            .is_some_and(|(t, s)| !t.is_empty() && !s.is_empty() && mime.bytes().all(|b| b.is_ascii_alphanumeric() || b"/.+-_".contains(&b)));
    if ok { mime.to_ascii_lowercase() } else { "application/octet-stream".into() }
}

/// An output of the call's audio (docs/ANDROID.md "Audio output", `AudioRoutes.kt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioRoute {
    Speaker,
    Earpiece,
    Bluetooth,
    Wired,
}

/// The routes the call can use now and the one in use (none while no voice runs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioRoutes {
    pub available: Vec<AudioRoute>,
    #[serde(default)]
    pub current: Option<AudioRoute>,
}

impl AudioRoutes {
    /// Each route at most once.
    pub fn valid(&self) -> bool {
        self.available.len() <= 4 && self.available.iter().enumerate().all(|(i, r)| !self.available[..i].contains(r))
    }
}

/// An orientation of the Screen Orientation API (`OrientationLockType`) the page may lock to in fullscreen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OrientationLock {
    Any,
    Natural,
    Landscape,
    Portrait,
    LandscapePrimary,
    LandscapeSecondary,
    PortraitPrimary,
    PortraitSecondary,
}

/// What the Kotlin side reports (`ShellPlugin.kt`, JSON with a `kind`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeEvent {
    /// The system back gesture or button.
    Back,
    /// An app link or a `tavrn://` link opened the app.
    Link {
        url: String,
    },
    /// A notification was tapped.
    Open {
        path: String,
    },
    /// A button of the voice notification.
    Voice {
        action: String,
    },
    Insets(Insets),
    /// The distributor handed a (new) endpoint.
    PushEndpoint(PushEndpoint),
    /// The distributor dropped the registration.
    PushUnregistered,
    /// The call's audio routes changed (a headset came or went, the user or the system moved the audio).
    AudioRoutes(AudioRoutes),
}

/// The event for the client, or none when the Kotlin side reported something invalid.
pub fn shell_event(event: NativeEvent) -> Option<ShellEvent> {
    match event {
        NativeEvent::Back => Some(ShellEvent::Back),
        NativeEvent::Link { url } => app_link(&url).map(|url| ShellEvent::Link { url }),
        NativeEvent::Open { path } => client_path(&path).then_some(ShellEvent::Open { path }),
        NativeEvent::Voice { action } => match action.as_str() {
            "mute" => Some(ShellEvent::Tray { action: TrayAction::Mute }),
            "leave" => Some(ShellEvent::Tray { action: TrayAction::Leave }),
            _ => None,
        },
        NativeEvent::Insets(insets) => insets.valid().then_some(ShellEvent::Insets(insets)),
        NativeEvent::PushEndpoint(endpoint) => endpoint.valid().then_some(ShellEvent::PushEndpoint(endpoint)),
        NativeEvent::PushUnregistered => Some(ShellEvent::PushUnregistered),
        NativeEvent::AudioRoutes(routes) => routes.valid().then_some(ShellEvent::AudioRoutes(routes)),
    }
}

/// Parses an event of the Kotlin side.
pub fn parse_native(json: &str) -> Option<ShellEvent> {
    serde_json::from_str::<NativeEvent>(json).ok().and_then(shell_event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_links_are_invites_and_add_links_on_known_hosts() {
        assert_eq!(app_link("https://app.tavrn.org/invite/AbCd_123").as_deref(), Some("https://app.tavrn.org/invite/AbCd_123"));
        assert_eq!(app_link("https://APP.tavrn.org/add/01J9ZQ/").as_deref(), Some("https://app.tavrn.org/add/01J9ZQ"));
        assert_eq!(
            app_link("https://app.tavrn.org/add/other.example/01J9ZQ?room=tavrn.org%2F01AB").as_deref(),
            Some("https://app.tavrn.org/add/other.example/01J9ZQ?room=tavrn.org%2F01AB")
        );
        // The fallback scheme names any node's host.
        assert_eq!(app_link("tavrn://chat.example/invite/code1234").as_deref(), Some("https://chat.example/invite/code1234"));
    }

    #[test]
    fn everything_else_stays_out() {
        for bad in [
            "https://evil.example/invite/code1234",
            "http://app.tavrn.org/invite/code1234",
            "https://app.tavrn.org:8443/invite/code1234",
            "https://user@app.tavrn.org/invite/code1234",
            "https://app.tavrn.org/settings",
            "https://app.tavrn.org/invite/abc",
            "https://app.tavrn.org/invite/code1234/more",
            "https://app.tavrn.org/invite/code1234?next=/admin",
            "https://app.tavrn.org/invite/code1234#x",
            "https://app.tavrn.org/add/01J9ZQ?room=a&room=b",
            "https://app.tavrn.org/add/not_a_domain/01J9ZQ",
            "tavrn://127.0.0.1/invite/code1234",
            "tavrn://localhost/invite/code1234",
            "javascript://app.tavrn.org/invite/code1234",
            "file:///invite/code1234",
            "not a url",
        ] {
            assert_eq!(app_link(bad), None, "{bad}");
        }
        assert_eq!(app_link(&format!("https://app.tavrn.org/invite/{}", "a".repeat(600))), None);
    }

    #[test]
    fn saves_suggest_plain_names_and_types() {
        assert_eq!(save_name("tavrn-recovery-key.txt"), "tavrn-recovery-key.txt");
        assert_eq!(save_name("../../etc/passwd"), "passwd");
        assert_eq!(save_name("a\\b\u{0}c.pdf"), "bc.pdf");
        assert_eq!(save_name(".."), "download");
        assert_eq!(save_name(""), "download");
        assert_eq!(save_name(&"x".repeat(500)).chars().count(), 200);
        assert_eq!(save_mime("text/plain"), "text/plain");
        assert_eq!(save_mime("image/svg+xml"), "image/svg+xml");
        for bad in ["text", "text/plain; charset=utf-8", "*/*\n", ""] {
            assert_eq!(save_mime(bad), "application/octet-stream", "{bad:?}");
        }
        assert!(save_chunk("c2VjcmV0"));
        assert!(save_chunk(&"A".repeat(SAVE_CHUNK_BYTES.div_ceil(3) * 4)));
        assert!(!save_chunk(&"A".repeat(SAVE_CHUNK_BYTES.div_ceil(3) * 4 + 4)));
        assert!(!save_chunk("not base64!"));
        assert!(!save_chunk(""));
        assert!(save_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!save_id("../x"));
    }

    #[test]
    fn notification_clicks_open_only_client_paths() {
        assert!(client_path("/rooms/1/channels/2"));
        for bad in ["rooms/1", "//evil.example", "/a b", "/a\\b", "https://x/"] {
            assert!(!client_path(bad), "{bad}");
        }
    }

    fn notice() -> VoiceNotice {
        VoiceNotice {
            state: VoiceState::Speaking,
            title: "In voice channel Lounge (Gaming)".into(),
            text: "Speaking".into(),
            mute: "Mute".into(),
            unmute: "Unmute".into(),
            leave: "Leave".into(),
            camera: false,
        }
    }

    #[test]
    fn the_voice_notice_is_checked_and_does_not_flicker() {
        assert_eq!(notice().validate(), Ok(()));
        assert_eq!(notice().shown_state(), VoiceState::Connected);
        assert_eq!(VoiceNotice { state: VoiceState::Muted, ..notice() }.shown_state(), VoiceState::Muted);
        for bad in
            [VoiceNotice { title: " ".into(), ..notice() }, VoiceNotice { leave: "x".repeat(201), ..notice() }, VoiceNotice { text: "a\nb".into(), ..notice() }]
        {
            assert_eq!(bad.validate(), Err("android.invalid"));
        }
    }

    #[test]
    fn push_texts_only_with_known_keys() {
        let ok = PushConfig { strings: [("message".to_string(), "Neue Nachricht von {sender}".to_string())].into(), home_node: Some("tavrn.org".into()) };
        assert_eq!(ok.validate(), Ok(()));
        assert_eq!(PushConfig { home_node: Some("localhost:8400".into()), ..ok.clone() }.validate(), Ok(()));
        assert_eq!(PushConfig { strings: [("script".to_string(), "x".to_string())].into(), ..ok.clone() }.validate(), Err("android.invalid"));
        assert_eq!(PushConfig { home_node: Some("evil example".into()), ..ok }.validate(), Err("android.invalid"));
    }

    #[test]
    fn vapid_keys_are_uncompressed_points() {
        let key = format!("B{}", "A".repeat(86));
        assert_eq!(vapid_key(&key).as_deref(), Some(key.as_str()));
        assert_eq!(vapid_key(&format!("{key}=")).as_deref(), Some(key.as_str()));
        assert_eq!(vapid_key("BAAA"), None);
        assert_eq!(vapid_key(&format!("B{}+", "A".repeat(85))), None);
    }

    #[test]
    fn events_of_the_kotlin_side_are_checked() {
        assert_eq!(parse_native(r#"{"kind":"back"}"#), Some(ShellEvent::Back));
        assert_eq!(parse_native(r#"{"kind":"voice","action":"leave"}"#), Some(ShellEvent::Tray { action: TrayAction::Leave }));
        assert_eq!(parse_native(r#"{"kind":"voice","action":"quit"}"#), None);
        assert_eq!(parse_native(r#"{"kind":"open","path":"/conversations/1"}"#), Some(ShellEvent::Open { path: "/conversations/1".into() }));
        assert_eq!(parse_native(r#"{"kind":"open","path":"https://evil.example"}"#), None);
        assert_eq!(
            parse_native(r#"{"kind":"link","url":"https://app.tavrn.org/invite/code1234"}"#),
            Some(ShellEvent::Link { url: "https://app.tavrn.org/invite/code1234".into() })
        );
        assert_eq!(parse_native(r#"{"kind":"link","url":"https://evil.example/invite/code1234"}"#), None);
        let insets = json!({ "kind": "insets", "top": 24.0, "right": 0.0, "bottom": 48.0, "left": 0.0, "keyboard": 0.0 }).to_string();
        assert_eq!(parse_native(&insets), Some(ShellEvent::Insets(Insets { top: 24.0, right: 0.0, bottom: 48.0, left: 0.0, keyboard: 0.0 })));
        assert_eq!(parse_native(r#"{"kind":"insets","top":-1,"right":0,"bottom":0,"left":0}"#), None);
        let endpoint =
            json!({ "kind": "push_endpoint", "endpoint": "https://ntfy.example/upAbC?up=1", "p256dh": "B".repeat(87), "auth": "a".repeat(22) }).to_string();
        assert!(matches!(parse_native(&endpoint), Some(ShellEvent::PushEndpoint(_))));
        let plain = json!({ "kind": "push_endpoint", "endpoint": "http://ntfy.example/up", "p256dh": "B".repeat(87), "auth": "a".repeat(22) }).to_string();
        assert_eq!(parse_native(&plain), None);
        assert_eq!(parse_native(r#"{"kind":"push_unregistered"}"#), Some(ShellEvent::PushUnregistered));
        assert_eq!(
            parse_native(r#"{"kind":"audio_routes","available":["speaker","earpiece","bluetooth"],"current":"bluetooth"}"#),
            Some(ShellEvent::AudioRoutes(AudioRoutes {
                available: vec![AudioRoute::Speaker, AudioRoute::Earpiece, AudioRoute::Bluetooth],
                current: Some(AudioRoute::Bluetooth)
            }))
        );
        // No voice running: no route in use (the Kotlin side leaves `current` out).
        assert_eq!(
            parse_native(r#"{"kind":"audio_routes","available":["speaker"]}"#),
            Some(ShellEvent::AudioRoutes(AudioRoutes { available: vec![AudioRoute::Speaker], current: None }))
        );
        assert_eq!(parse_native(r#"{"kind":"audio_routes","available":["speaker","speaker"]}"#), None);
        assert_eq!(parse_native(r#"{"kind":"audio_routes","available":["hdmi"]}"#), None);
        assert_eq!(parse_native(r#"{"kind":"unknown"}"#), None);
        assert_eq!(parse_native("not json"), None);
    }

    #[test]
    fn the_client_receives_android_events_in_its_shape() -> serde_json::Result<()> {
        assert_eq!(serde_json::to_string(&ShellEvent::Back)?, r#"{"kind":"back"}"#);
        assert_eq!(
            serde_json::to_string(&ShellEvent::Link { url: "https://app.tavrn.org/invite/x".into() })?,
            r#"{"kind":"link","url":"https://app.tavrn.org/invite/x"}"#
        );
        assert_eq!(
            serde_json::to_string(&ShellEvent::Insets(Insets { top: 1.0, ..Insets::default() }))?,
            r#"{"kind":"insets","top":1.0,"right":0.0,"bottom":0.0,"left":0.0,"keyboard":0.0}"#
        );
        assert_eq!(serde_json::to_string(&ShellEvent::PushUnregistered)?, r#"{"kind":"push_unregistered"}"#);
        assert_eq!(
            serde_json::to_string(&ShellEvent::AudioRoutes(AudioRoutes {
                available: vec![AudioRoute::Speaker, AudioRoute::Wired],
                current: Some(AudioRoute::Wired)
            }))?,
            r#"{"kind":"audio_routes","available":["speaker","wired"],"current":"wired"}"#
        );
        Ok(())
    }

    #[test]
    fn orientation_locks_are_the_screen_orientation_apis_names() -> serde_json::Result<()> {
        assert_eq!(serde_json::from_str::<OrientationLock>(r#""landscape""#)?, OrientationLock::Landscape);
        assert_eq!(serde_json::from_str::<OrientationLock>(r#""portrait-secondary""#)?, OrientationLock::PortraitSecondary);
        assert_eq!(serde_json::to_string(&OrientationLock::LandscapePrimary)?, r#""landscape-primary""#);
        assert!(serde_json::from_str::<OrientationLock>(r#""sideways""#).is_err());
        assert!(serde_json::from_str::<AudioRoute>(r#""hdmi""#).is_err());
        Ok(())
    }
}
