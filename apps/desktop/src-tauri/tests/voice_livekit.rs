// SPDX-License-Identifier: Apache-2.0
//! The native voice engine against a real LiveKit server (docs/DESKTOP.md "Voice", `just desktop-voice-test`): two
//! engines with the fake audio backend join one room end-to-end encrypted with a fixed key; the listener's speakers
//! play the talker's tone, the speaking levels arrive, a third engine with another key hears nothing (the frames
//! really are encrypted), and after a key change of both the voice keeps flowing. Needs `livekit-server` on the PATH;
//! ignored by a plain `cargo test`.
#![cfg(feature = "native-voice")]

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use tavrn_desktop_lib::voice::audio::FakeIo;
use tavrn_desktop_lib::voice::engine::Engine;
use tavrn_desktop_lib::voice::uplink::Control;
use tavrn_desktop_lib::voice::{JoinArgs, VoiceConfig, VoiceEvent};
use tokio::sync::mpsc;

/// Ports of this test's server (signalling, ICE over TCP, the UDP range), apart from the end-to-end suite's.
const PORT: u16 = 9690;
const TCP_PORT: u16 = 10690;
const UDP_RANGE: (u16, u16) = (48500, 48649);
const API_KEY: &str = "tavrn-voice-test";
const API_SECRET: &str = "tavrn-voice-test-secret-0123456789abcdef";

struct Server(Child, std::path::PathBuf);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

fn start_server() -> Server {
    // A server of an earlier run may still be shutting down on the port.
    let free = Instant::now() + Duration::from_secs(15);
    while TcpStream::connect(("127.0.0.1", PORT)).is_ok() {
        assert!(Instant::now() < free, "port {PORT} is taken");
        std::thread::sleep(Duration::from_millis(200));
    }
    let dir = std::env::temp_dir().join(format!("tavrn-voice-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| unreachable!("temp dir: {e}"));
    let config = dir.join("livekit.yaml");
    std::fs::write(
        &config,
        format!(
            "port: {PORT}\nbind_addresses: [\"127.0.0.1\"]\nrtc:\n  tcp_port: {TCP_PORT}\n  port_range_start: {}\n  port_range_end: {}\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  {API_KEY}: {API_SECRET}\nlogging:\n  level: warn\n",
            UDP_RANGE.0, UDP_RANGE.1
        ),
    )
    .unwrap_or_else(|e| unreachable!("config: {e}"));
    let child = Command::new(std::env::var("TAVRN_LIVEKIT_BINARY").unwrap_or_else(|_| "livekit-server".into()))
        .arg("--config")
        .arg(&config)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| unreachable!("livekit-server could not start (on the PATH? TAVRN_LIVEKIT_BINARY?): {e}"));
    let server = Server(child, dir);
    let end = Instant::now() + Duration::from_secs(15);
    while TcpStream::connect(("127.0.0.1", PORT)).is_err() {
        assert!(Instant::now() < end, "livekit-server did not listen on {PORT}");
        std::thread::sleep(Duration::from_millis(100));
    }
    server
}

/// A LiveKit access token (HS256) for `identity` in `room`.
fn token(identity: &str, room: &str) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = serde_json::json!({
        "iss": API_KEY, "sub": identity, "nbf": now - 10, "exp": now + 600, "name": identity,
        "video": { "room": room, "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true },
    });
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, API_SECRET.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(ring::hmac::sign(&key, format!("{header}.{payload}").as_bytes()).as_ref());
    format!("{header}.{payload}.{signature}")
}

fn config() -> VoiceConfig {
    // No audio processing (noise suppression would treat a steady tone as noise) and no gate.
    VoiceConfig {
        input_device: None,
        output_device: None,
        input_volume: 100,
        echo_cancellation: false,
        noise_suppression: false,
        auto_gain: false,
        ptt: false,
        threshold: None,
        hold_ms: 300,
        ptt_release_ms: 250,
    }
}

struct Peer {
    engine: Engine,
    io: Arc<FakeIo>,
    events: Arc<Mutex<Vec<VoiceEvent>>>,
}

async fn join(identity: &str, room: &str, key: [u8; 32], epoch: u64, tone: f32) -> Peer {
    let io = Arc::new(FakeIo::default());
    if let Ok(mut t) = io.tone.lock() {
        *t = tone;
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let events = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&events);
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            if let Ok(mut l) = log.lock() {
                l.push(e);
            }
        }
    });
    let args = JoinArgs {
        url: format!("ws://127.0.0.1:{PORT}"),
        token: token(identity, room),
        key: zeroize::Zeroizing::new(key.to_vec()),
        epoch,
        bitrate_kbps: 32,
        config: config(),
        muted: false,
        deafened: false,
    };
    let (engine, reply) =
        Engine::join(args, io.clone(), Arc::new(Control::default()), tx).await.unwrap_or_else(|e| unreachable!("{identity} could not join: {e}"));
    assert_eq!(reply.identity, identity);
    assert!(reply.can_speak);
    Peer { engine, io, events }
}

/// The loudest output level (dBFS) of the last `windows` 100 ms windows.
fn recent_peak(io: &FakeIo, windows: usize) -> f64 {
    let levels = io.levels.lock().map(|l| l.clone()).unwrap_or_default();
    levels.iter().rev().take(windows).copied().fold(f64::NEG_INFINITY, f64::max)
}

async fn until(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let end = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs livekit-server (just desktop-voice-test)"]
async fn native_engines_hear_each_other_end_to_end_encrypted() {
    let _server = start_server();
    let key = [0x5a; 32];
    let room = "voice-test";
    let alice = join("alice@a.test/1", room, key, 7, 0.3).await;
    let bob = join("bob@b.test/1", room, key, 7, 0.0).await;
    let eve = join("eve@e.test/1", room, [0x11; 32], 7, 0.0).await;

    // Bob's speakers play Alice's tone (a 0.3 sine is about -13.5 dBFS; Opus keeps it within a few dB).
    until("bob to hear alice", Duration::from_secs(20), || recent_peak(&bob.io, 5) > -25.0).await;
    // Bob's engine reports Alice speaking and lists her microphone.
    until("alice's speaking level at bob", Duration::from_secs(5), || {
        bob.events
            .lock()
            .map(|l| {
                l.iter().any(
                    |e| matches!(e, VoiceEvent::Speakers { levels } if levels.iter().any(|(id, db)| id == "alice@a.test/1" && db.is_some_and(|d| d > -30.0))),
                )
            })
            .unwrap_or(false)
    })
    .await;
    assert!(bob.events.lock().map(|l| l.iter().any(|e| matches!(e, VoiceEvent::Participants { participants } if participants.iter().any(|p| p.identity == "alice@a.test/1" && p.mic && !p.mic_muted)))).unwrap_or(false));
    // Eve has another key: Alice's frames do not decrypt, nothing plays.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(recent_peak(&eve.io, 20) < -60.0, "eve heard {} dBFS without the key", recent_peak(&eve.io, 20));

    // A new epoch: Alice sends with the new key at index 8; Bob has it, so the voice keeps flowing.
    let next = [0x6b; 32];
    assert!(bob.engine.set_key(&next, 8));
    assert!(alice.engine.set_key(&next, 8));
    assert!(!alice.engine.set_key(&key, 7), "an older epoch never comes back");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    until("bob to hear alice after the key change", Duration::from_secs(10), || recent_peak(&bob.io, 5) > -25.0).await;

    // Muted, Alice sends nothing.
    alice.engine.set_muted(true);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(recent_peak(&bob.io, 5) < -60.0, "bob still hears {} dBFS", recent_peak(&bob.io, 5));
    // Deafened, Bob plays nothing even when Alice talks again.
    bob.engine.set_deafened(true);
    alice.engine.set_muted(false);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(recent_peak(&bob.io, 5) < -60.0);
    bob.engine.set_deafened(false);
    until("bob to hear alice again", Duration::from_secs(10), || recent_peak(&bob.io, 5) > -25.0).await;

    for p in [alice, bob, eve] {
        p.engine.leave().await;
    }
}
