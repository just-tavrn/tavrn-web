// SPDX-License-Identifier: Apache-2.0
//! The native voice engine (docs/DESKTOP.md "Voice"): a LiveKit room joined by the shell with LiveKit's Rust SDK
//! (libwebrtc), the microphone captured and every remote voice played natively. The webview keeps everything else of
//! a call: the node's routes, the MLS group and the frame key of each epoch (handed over with `voice_set_key`), the
//! voice settings, the notification sounds and the UI. The engine reports levels, push-to-talk, participants,
//! connection and encryption state over one IPC channel (`voice_join`'s `on_event`).
//!
//! On Linux the webview has no WebRTC, so the client always uses this engine there; on Windows it is the setting
//! "Native voice engine (experimental)". Audio only in this slice: camera and screen sharing stay with the browser
//! engine. Without the Cargo feature `native-voice` the commands exist but answer `voice.native_unavailable`.
//!
//! Security: the frame keys live in memory only (never in a log, a file or an error message); every argument from the
//! webview is validated with limits; the commands are granted to the main window only (capabilities/main.json).

pub mod audio;
pub mod dsp;
pub mod e2ee;
pub mod gate;
pub mod mix;
pub mod uplink;

#[cfg(feature = "native-voice")]
pub mod engine;

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use self::audio::{AudioIo, Devices};
use self::uplink::{Control, Processing, UplinkConfig};

/// What the engine reports to the webview (`kind` tags the event; fields in snake_case).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoiceEvent {
    /// The own gate: dBFS of the loudest frame of the last ~100 ms (`null` for silence) and whether it transmits.
    Level {
        level: Option<f64>,
        open: bool,
    },
    /// Push-to-talk opened or closed (after its release delay): the push-to-talk tones.
    Ptt {
        open: bool,
    },
    /// The loudest 10 ms RMS (dBFS, `null` for silence) of every remote participant's voice of the last 50 ms.
    Speakers {
        levels: Vec<(String, Option<f64>)>,
    },
    /// Everybody in the call (the own device included) with their microphone state.
    Participants {
        participants: Vec<ParticipantInfo>,
    },
    /// The node granted or revoked the microphone (a server mute, VOICE.md §7).
    Permissions {
        can_speak: bool,
    },
    Quality {
        identity: String,
        quality: &'static str,
    },
    /// The frame cryptor's state of a participant (`ok`, `missing_key`, `decryption_failed`, ...).
    Encryption {
        identity: String,
        state: &'static str,
    },
    Reconnecting,
    Reconnected,
    /// The room is gone (`reason` in LiveKit's snake_case names: `participant_removed`, `room_deleted`, ...).
    Disconnected {
        reason: String,
    },
    Error {
        code: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParticipantInfo {
    pub identity: String,
    /// Publishes a microphone track.
    pub mic: bool,
    pub mic_muted: bool,
    pub local: bool,
}

/// The voice settings the engine needs (the web client's `VoiceSettings`, already resolved by the client).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    /// Percent, 0–200.
    pub input_volume: u32,
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain: bool,
    /// Push-to-talk instead of voice activation.
    pub ptt: bool,
    /// Gate threshold in dBFS (`gateThreshold` of the client), `null`: no gate.
    pub threshold: Option<f64>,
    pub hold_ms: u32,
    pub ptt_release_ms: u32,
}

const MAX_ID: usize = 512;

impl VoiceConfig {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = |d: &Option<String>| d.as_ref().is_none_or(|d| d.len() <= MAX_ID);
        let ok = id_ok(&self.input_device)
            && id_ok(&self.output_device)
            && self.input_volume <= 200
            && self.threshold.is_none_or(|t| t.is_finite() && (-100.0..=0.0).contains(&t))
            && self.hold_ms <= 5_000
            && self.ptt_release_ms <= 2_000;
        if ok { Ok(()) } else { Err("voice.invalid_config".into()) }
    }

    pub fn uplink(&self) -> UplinkConfig {
        UplinkConfig {
            input_gain: self.input_volume as f32 / 100.0,
            threshold: self.threshold,
            hold_ms: self.hold_ms,
            ptt_mode: self.ptt,
            ptt_release_ms: self.ptt_release_ms,
            processing: Processing { echo_cancellation: self.echo_cancellation, noise_suppression: self.noise_suppression, auto_gain: self.auto_gain },
        }
    }

    fn device(d: &Option<String>) -> Option<&str> {
        d.as_deref().filter(|d| !d.is_empty())
    }

    pub fn input(&self) -> Option<&str> {
        Self::device(&self.input_device)
    }

    pub fn output(&self) -> Option<&str> {
        Self::device(&self.output_device)
    }
}

/// `voice_join`: the room (LiveKit URL and token from the node's join route), the frame key of the current epoch, the
/// channel's bitrate and the settings.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinArgs {
    pub url: String,
    pub token: String,
    pub key: Vec<u8>,
    pub epoch: u64,
    pub bitrate_kbps: u32,
    pub config: VoiceConfig,
    pub muted: bool,
    pub deafened: bool,
}

/// Never prints the key or the token.
impl fmt::Debug for JoinArgs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JoinArgs").field("url", &self.url).field("epoch", &self.epoch).field("bitrate_kbps", &self.bitrate_kbps).finish_non_exhaustive()
    }
}

/// The LiveKit URL of a voice join answer: `wss://`/`https://` to any host, plain `ws://`/`http://` only to this computer
/// (a development node). The engine sends the room token over it, so it never goes out unencrypted.
fn voice_url_ok(url: &str) -> bool {
    if url.len() > 2_048 {
        return false;
    }
    let Ok(parsed) = tauri::Url::parse(url) else { return false };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let host = parsed.host_str().unwrap_or_default();
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match parsed.scheme() {
        "wss" | "https" => !host.is_empty(),
        "ws" | "http" => local,
        _ => false,
    }
}

impl JoinArgs {
    pub fn validate(&self) -> Result<(), String> {
        if !voice_url_ok(&self.url) {
            return Err("voice.invalid_url".into());
        }
        if self.token.is_empty() || self.token.len() > 8_192 {
            return Err("voice.invalid_token".into());
        }
        e2ee::validate_key(&self.key)?;
        if !(6..=512).contains(&self.bitrate_kbps) {
            return Err("voice.invalid_bitrate".into());
        }
        self.config.validate()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JoinReply {
    pub identity: String,
    pub can_speak: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceInfo {
    /// This build has the native engine.
    pub available: bool,
    /// `linux`, `windows`, `macos`: the client uses the engine always on Linux, on Windows when the setting is on.
    pub os: &'static str,
}

/// At most this many per-participant volumes per call (a call has far fewer participants).
const MAX_VOLUMES: usize = 512;

pub fn validate_volumes(volumes: &HashMap<String, f32>) -> Result<(), String> {
    let ok =
        volumes.len() <= MAX_VOLUMES && volumes.iter().all(|(k, v)| !k.is_empty() && k.len() <= MAX_ID && v.is_finite() && (0.0..=mix::MAX_GAIN).contains(v));
    if ok { Ok(()) } else { Err("voice.invalid_volume".into()) }
}

/// The shell's voice state: the push-to-talk and settings shared with the capture (also reached by the hotkey
/// listener), the audio backend and the running call.
pub struct VoiceShell {
    pub control: Arc<Control>,
    io: Arc<dyn AudioIo>,
    #[cfg(feature = "native-voice")]
    engine: tokio::sync::Mutex<Option<engine::Engine>>,
}

impl VoiceShell {
    pub fn new(io: Arc<dyn AudioIo>) -> Self {
        Self {
            control: Arc::default(),
            io,
            #[cfg(feature = "native-voice")]
            engine: tokio::sync::Mutex::new(None),
        }
    }

    /// Push-to-talk held or released (the webview's key or button, or the system-wide hotkey).
    pub fn ptt(&self, held: bool) {
        self.control.set_ptt(held);
    }
}

impl Default for VoiceShell {
    fn default() -> Self {
        Self::new(audio::from_env())
    }
}

const UNAVAILABLE: &str = "voice.native_unavailable";

#[tauri::command]
pub fn voice_info() -> VoiceInfo {
    VoiceInfo { available: cfg!(feature = "native-voice"), os: std::env::consts::OS }
}

#[tauri::command]
pub async fn voice_devices(voice: State<'_, VoiceShell>) -> Result<Devices, String> {
    let io = Arc::clone(&voice.io);
    tauri::async_runtime::spawn_blocking(move || io.devices()).await.map_err(|_| "voice.devices_failed".to_string())
}

#[cfg(feature = "native-voice")]
#[tauri::command]
pub async fn voice_join(voice: State<'_, VoiceShell>, args: JoinArgs, on_event: Channel<VoiceEvent>) -> Result<JoinReply, String> {
    args.validate()?;
    let mut slot = voice.engine.lock().await;
    if let Some(old) = slot.take() {
        old.leave().await;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    let (engine, reply) = engine::Engine::join(args, Arc::clone(&voice.io), Arc::clone(&voice.control), tx).await?;
    *slot = Some(engine);
    Ok(reply)
}

#[cfg(not(feature = "native-voice"))]
#[tauri::command]
pub async fn voice_join(args: JoinArgs, on_event: Channel<VoiceEvent>) -> Result<JoinReply, String> {
    let _ = (args, on_event);
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn voice_leave(voice: State<'_, VoiceShell>) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    if let Some(engine) = voice.engine.lock().await.take() {
        engine.leave().await;
    }
    voice.control.set_ptt(false);
    Ok(())
}

/// Hands the frame key of a new epoch to the engine; false when it is not newer than the current one.
#[tauri::command]
pub async fn voice_set_key(voice: State<'_, VoiceShell>, key: Vec<u8>, epoch: u64) -> Result<bool, String> {
    e2ee::validate_key(&key)?;
    #[cfg(feature = "native-voice")]
    if let Some(engine) = voice.engine.lock().await.as_ref() {
        return Ok(engine.set_key(&key, epoch));
    }
    let _ = (voice, epoch);
    Err("voice.not_connected".into())
}

#[tauri::command]
pub async fn voice_set_muted(voice: State<'_, VoiceShell>, muted: bool) -> Result<(), String> {
    voice.control.set_muted(muted);
    #[cfg(feature = "native-voice")]
    if let Some(engine) = voice.engine.lock().await.as_ref() {
        engine.set_muted(muted);
    }
    Ok(())
}

#[tauri::command]
pub async fn voice_set_deafened(voice: State<'_, VoiceShell>, deafened: bool) -> Result<(), String> {
    #[cfg(feature = "native-voice")]
    if let Some(engine) = voice.engine.lock().await.as_ref() {
        engine.set_deafened(deafened);
    }
    let _ = (voice, deafened);
    Ok(())
}

#[tauri::command]
pub fn voice_set_ptt(voice: State<'_, VoiceShell>, pressed: bool) {
    voice.ptt(pressed);
}

/// The settings changed during a call (devices, volume, processing, gate, push-to-talk).
#[tauri::command]
pub async fn voice_configure(voice: State<'_, VoiceShell>, config: VoiceConfig) -> Result<(), String> {
    config.validate()?;
    #[cfg(feature = "native-voice")]
    if let Some(engine) = voice.engine.lock().await.as_ref() {
        return engine.configure(&config);
    }
    voice.control.set_config(config.uplink());
    Ok(())
}

/// Playback gains per participant identity (1.0 = unchanged, 0 = silent; `volume.ts` of the client decides).
#[tauri::command]
pub async fn voice_set_volumes(voice: State<'_, VoiceShell>, volumes: HashMap<String, f32>) -> Result<(), String> {
    validate_volumes(&volumes)?;
    #[cfg(feature = "native-voice")]
    if let Some(engine) = voice.engine.lock().await.as_ref() {
        engine.set_volumes(&volumes);
    }
    let _ = voice;
    Ok(())
}

#[allow(dead_code)]
fn unavailable() -> String {
    UNAVAILABLE.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> VoiceConfig {
        VoiceConfig {
            input_device: None,
            output_device: Some(String::new()),
            input_volume: 100,
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain: false,
            ptt: false,
            threshold: Some(-55.0),
            hold_ms: 300,
            ptt_release_ms: 250,
        }
    }

    fn args() -> JoinArgs {
        JoinArgs {
            url: "wss://voice.example".into(),
            token: "t".into(),
            key: vec![7; 32],
            epoch: 3,
            bitrate_kbps: 32,
            config: config(),
            muted: false,
            deafened: false,
        }
    }

    #[test]
    fn join_arguments_are_validated() {
        assert!(args().validate().is_ok());
        assert_eq!(JoinArgs { url: "file:///etc/passwd".into(), ..args() }.validate(), Err("voice.invalid_url".into()));
        // The token travels over this URL: plain ws/http only to this computer.
        for plain in ["ws://voice.example", "http://voice.example:7880", "ws://10.0.0.5:7880", "ws://localhost.evil.example", "wss://user:pw@voice.example"] {
            assert_eq!(JoinArgs { url: plain.into(), ..args() }.validate(), Err("voice.invalid_url".into()), "{plain}");
        }
        for ok in ["wss://voice.example", "https://voice.example/rtc", "ws://127.0.0.1:7880", "ws://localhost:7880", "http://[::1]:7880"] {
            assert!(JoinArgs { url: ok.into(), ..args() }.validate().is_ok(), "{ok}");
        }
        assert_eq!(JoinArgs { url: format!("wss://{}", "a".repeat(3000)), ..args() }.validate(), Err("voice.invalid_url".into()));
        assert_eq!(JoinArgs { token: String::new(), ..args() }.validate(), Err("voice.invalid_token".into()));
        assert_eq!(JoinArgs { key: vec![1; 16], ..args() }.validate(), Err("voice.invalid_key".into()));
        assert_eq!(JoinArgs { bitrate_kbps: 0, ..args() }.validate(), Err("voice.invalid_bitrate".into()));
        assert_eq!(JoinArgs { config: VoiceConfig { input_volume: 900, ..config() }, ..args() }.validate(), Err("voice.invalid_config".into()));
        assert_eq!(JoinArgs { config: VoiceConfig { threshold: Some(f64::NAN), ..config() }, ..args() }.validate(), Err("voice.invalid_config".into()));
        assert_eq!(
            JoinArgs { config: VoiceConfig { input_device: Some("x".repeat(600)), ..config() }, ..args() }.validate(),
            Err("voice.invalid_config".into())
        );
    }

    #[test]
    fn debug_output_never_shows_the_key_or_the_token() {
        let printed = format!("{:?}", JoinArgs { token: "secret-token".into(), key: vec![0xAB; 32], ..args() });
        assert!(!printed.contains("secret-token"));
        assert!(!printed.contains("171"), "{printed}");
        assert!(printed.contains("wss://voice.example"));
    }

    #[test]
    fn the_config_maps_to_the_uplink() {
        let c = VoiceConfig { input_volume: 150, ptt: true, ..config() }.uplink();
        assert_eq!(c.input_gain, 1.5);
        assert!(c.ptt_mode);
        assert_eq!(c.threshold, Some(-55.0));
        assert!(c.processing.echo_cancellation && c.processing.noise_suppression && !c.processing.auto_gain);
        assert_eq!(config().output(), None, "an empty id is the system default");
    }

    #[test]
    fn volumes_are_validated() {
        let mut v = HashMap::new();
        v.insert("alice@a.example/1".to_string(), 1.5);
        assert!(validate_volumes(&v).is_ok());
        v.insert("bob/1".to_string(), 9.0);
        assert!(validate_volumes(&v).is_err());
        let mut nan = HashMap::new();
        nan.insert("x".to_string(), f32::NAN);
        assert!(validate_volumes(&nan).is_err());
    }

    #[test]
    fn events_serialize_as_the_client_expects() -> serde_json::Result<()> {
        assert_eq!(serde_json::to_string(&VoiceEvent::Level { level: Some(-20.0), open: true })?, r#"{"kind":"level","level":-20.0,"open":true}"#);
        assert_eq!(serde_json::to_string(&VoiceEvent::Speakers { levels: vec![("a/1".into(), None)] })?, r#"{"kind":"speakers","levels":[["a/1",null]]}"#);
        assert_eq!(serde_json::to_string(&VoiceEvent::Permissions { can_speak: false })?, r#"{"kind":"permissions","can_speak":false}"#);
        assert_eq!(serde_json::to_string(&VoiceEvent::Reconnecting)?, r#"{"kind":"reconnecting"}"#);
        assert_eq!(serde_json::to_string(&VoiceEvent::Disconnected { reason: "room_deleted".into() })?, r#"{"kind":"disconnected","reason":"room_deleted"}"#);
        Ok(())
    }

    #[test]
    fn join_arguments_come_in_camel_case() -> serde_json::Result<()> {
        let a: JoinArgs = serde_json::from_str(
            r#"{"url":"wss://v.example","token":"t","key":[1,2],"epoch":1,"bitrateKbps":32,"muted":true,"deafened":false,
                "config":{"inputDevice":null,"outputDevice":"pulseaudio:x","inputVolume":100,"echoCancellation":true,"noiseSuppression":false,
                "autoGain":true,"ptt":false,"threshold":-50,"holdMs":300,"pttReleaseMs":250}}"#,
        )?;
        assert_eq!(a.config.output(), Some("pulseaudio:x"));
        assert!(a.muted);
        Ok(())
    }
}
