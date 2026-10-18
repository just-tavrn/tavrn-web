// SPDX-License-Identifier: Apache-2.0
//! The LiveKit side of the native engine: joins the room with end-to-end encryption (`e2ee.rs`), publishes the
//! microphone once the frame cryptor of the own track is active (never unencrypted, VOICE.md §6), subscribes to the
//! remote audio tracks except a screen share's (streams are opt-in, as in the browser engine, and this engine has no
//! video to join one with; cameras are never received either), feeds the remote audio into the playback mix (`mix.rs`), follows the node's permission changes
//! (server mute), reconnects through the SDK and reports everything to the webview as [`VoiceEvent`]s.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{FutureExt, StreamExt};
use livekit::e2ee::key_provider::KeyProvider;
use livekit::e2ee::{E2eeOptions, EncryptionType};
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::*;
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::native::apm::AudioProcessingModule;
use livekit::webrtc::native::frame_cryptor::EncryptionState;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

use super::audio::{AudioIo, StreamHandle};
use super::dsp::{FRAME, RATE, Resampler, from_i16, to_i16, upmix};
use super::e2ee::{self, KeyRing};
use super::mix::Mixer;
use super::uplink::{Control, Processing, Processor, Uplink, UplinkReport};
use super::{JoinArgs, JoinReply, ParticipantInfo, VoiceConfig, VoiceEvent};

/// Speaking levels go to the webview this often (`SPEAKING_POLL_MS` of the client).
const LEVELS_EVERY: Duration = Duration::from_millis(50);
/// The publication of the microphone must be confirmed encrypted within this time (`E2EE_CONFIRM_MS` of the client).
const E2EE_CONFIRM: Duration = Duration::from_secs(10);

/// WebRTC's audio processing of the capture; the playback mix is its echo reference.
struct Apm(AudioProcessingModule);

// SAFETY: the C++ AudioProcessing object is thread-safe (it locks internally); the engine also serializes every
// access through a Mutex, and the handle is never shared without it.
unsafe impl Send for Apm {}

impl Apm {
    fn new(p: Processing) -> Option<Self> {
        if !p.any() {
            return None;
        }
        let mut apm = AudioProcessingModule::new(p.echo_cancellation, p.auto_gain, true, p.noise_suppression);
        // Device latencies are unknown; AEC3 estimates the remaining delay itself.
        let _ = apm.set_stream_delay_ms(40);
        Some(Self(apm))
    }

    fn render(&mut self, frame: &mut [i16]) {
        let _ = self.0.process_reverse_stream(frame, RATE as i32, 1);
    }
}

impl Processor for Apm {
    fn capture(&mut self, frame: &mut [i16]) {
        let _ = self.0.process_stream(frame, RATE as i32, 1);
    }
}

type Shared<T> = Arc<Mutex<T>>;

/// The parts of a call the audio threads and the event task share.
struct Parts {
    io: Arc<dyn AudioIo>,
    control: Arc<Control>,
    mixer: Shared<Mixer>,
    apm: Shared<Option<Apm>>,
    processing: Mutex<Processing>,
    source: NativeAudioSource,
    events: UnboundedSender<VoiceEvent>,
    publication: Mutex<Option<LocalTrackPublication>>,
    input: Mutex<Option<StreamHandle>>,
    output: Mutex<Option<StreamHandle>>,
    devices: Mutex<(Option<String>, Option<String>)>,
    downlinks: Mutex<HashMap<String, JoinHandle<()>>>,
    bitrate_kbps: u32,
    /// The newest epoch whose key was set: its index is the sending key index.
    ring: Mutex<KeyRing>,
}

impl Parts {
    fn send(&self, event: VoiceEvent) {
        let _ = self.events.send(event);
    }

    fn sending_index(&self) -> i32 {
        e2ee::key_index(lock(&self.ring).current().unwrap_or(0))
    }
}

pub struct Engine {
    room: Arc<Room>,
    key_provider: KeyProvider,
    parts: Arc<Parts>,
    tasks: Vec<JoinHandle<()>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `TrackSource.MICROPHONE` of LiveKit's protocol (the SDK does not re-export the protocol types).
const PROTO_MICROPHONE: i32 = 2;

/// The node lets this device publish its microphone (`canPublish` of the web client's session).
fn may_publish_mic(can_publish: bool, sources: &[i32]) -> bool {
    can_publish && (sources.is_empty() || sources.contains(&PROTO_MICROPHONE))
}

macro_rules! can_speak {
    ($permission:expr) => {
        $permission.as_ref().is_some_and(|p| may_publish_mic(p.can_publish, &p.can_publish_sources))
    };
}

fn quality_name(q: ConnectionQuality) -> &'static str {
    match q {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
    }
}

fn encryption_name(s: EncryptionState) -> &'static str {
    match s {
        EncryptionState::New => "new",
        EncryptionState::Ok => "ok",
        EncryptionState::EncryptionFailed => "encryption_failed",
        EncryptionState::DecryptionFailed => "decryption_failed",
        EncryptionState::MissingKey => "missing_key",
        EncryptionState::KeyRatcheted => "key_ratcheted",
        EncryptionState::InternalError => "internal_error",
    }
}

/// LiveKit's disconnect reason in snake_case (what the client's `onDisconnected` decides on).
fn reason_name(r: livekit::DisconnectReason) -> String {
    let name = format!("{r:?}");
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn finite(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

impl Engine {
    /// Connects, confirms encryption, starts the playback and publishes the microphone (when allowed).
    pub async fn join(args: JoinArgs, io: Arc<dyn AudioIo>, control: Arc<Control>, events: UnboundedSender<VoiceEvent>) -> Result<(Self, JoinReply), String> {
        control.set_config(args.config.uplink());
        control.set_muted(args.muted);
        let key_provider = e2ee::provider(&args.key, args.epoch);
        let mut ring = KeyRing::default();
        ring.mark(args.epoch);
        let mut options = RoomOptions::default();
        // Nothing is subscribed by itself: screen shares (video and audio) are opt-in and never joined here.
        options.auto_subscribe = false;
        options.encryption = Some(E2eeOptions { encryption_type: EncryptionType::Gcm, key_provider: key_provider.clone() });
        let (room, mut rx) = Room::connect(&args.url, &args.token, options).await.map_err(|e| {
            eprintln!("tavrn: voice: connecting failed: {e}");
            "voice.connect_failed".to_string()
        })?;
        let room = Arc::new(room);
        if !room.e2ee_manager().enabled() {
            let _ = room.close().await;
            return Err("voice.e2ee_failed".into());
        }
        let processing = args.config.uplink().processing;
        let mut mixer = Mixer::default();
        mixer.set_deafened(args.deafened);
        let parts = Arc::new(Parts {
            io,
            control,
            mixer: Arc::new(Mutex::new(mixer)),
            apm: Arc::new(Mutex::new(Apm::new(processing))),
            processing: Mutex::new(processing),
            source: NativeAudioSource::new(AudioSourceOptions::default(), RATE, 1, 0),
            events,
            publication: Mutex::new(None),
            input: Mutex::new(None),
            output: Mutex::new(None),
            devices: Mutex::new((args.config.input().map(str::to_string), args.config.output().map(str::to_string))),
            downlinks: Mutex::new(HashMap::new()),
            bitrate_kbps: args.bitrate_kbps,
            ring: Mutex::new(ring),
        });
        let mut engine = Engine { room: Arc::clone(&room), key_provider, parts: Arc::clone(&parts), tasks: Vec::new() };
        if let Err(e) = start_output(&parts) {
            engine.leave().await;
            return Err(e);
        }
        // Those already in the room: their microphones now, never their cameras or screen shares; tracks published
        // later follow as `TrackPublished` events.
        for participant in room.remote_participants().into_values() {
            for publication in participant.track_publications().into_values() {
                subscribe_wanted(&publication);
            }
        }
        let task_parts = Arc::clone(&parts);
        let task_room = Arc::clone(&room);
        engine.tasks.push(tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                handle(&task_parts, &task_room, event).await;
            }
        }));
        let level_parts = Arc::clone(&parts);
        engine.tasks.push(tokio::spawn(async move {
            let mut tick = tokio::time::interval(LEVELS_EVERY);
            loop {
                tick.tick().await;
                // Only while someone is audible (and once when all fell silent): no IPC every 50 ms in silence.
                let report = lock(&level_parts.mixer).take_report();
                if let Some(levels) = report {
                    level_parts.send(VoiceEvent::Speakers { levels: levels.into_iter().map(|(k, v)| (k, finite(v))).collect() });
                }
            }
        }));
        let local = room.local_participant();
        let speak = can_speak!(local.permission());
        if speak && let Err(e) = publish_mic(&parts, &room).await {
            engine.leave().await;
            return Err(e);
        }
        parts.send(participants(&room));
        Ok((engine, JoinReply { identity: local.identity().to_string(), can_speak: speak }))
    }

    /// The key of a newer epoch becomes the sending key (receivers pick keys by the index in each frame).
    pub fn set_key(&self, key: &[u8], epoch: u64) -> bool {
        let mut ring = lock(&self.parts.ring);
        if !ring.needs(epoch) {
            return false;
        }
        let index = e2ee::key_index(epoch);
        self.key_provider.set_shared_key(key.to_vec(), index);
        ring.mark(epoch);
        set_sending_index(&self.room, index);
        true
    }

    pub fn set_muted(&self, muted: bool) {
        self.parts.control.set_muted(muted);
        if let Some(p) = lock(&self.parts.publication).as_ref() {
            if muted { p.mute() } else { p.unmute() }
        }
    }

    pub fn set_deafened(&self, deafened: bool) {
        lock(&self.parts.mixer).set_deafened(deafened);
    }

    pub fn set_volumes(&self, volumes: &HashMap<String, f32>) {
        let mut mixer = lock(&self.parts.mixer);
        for (identity, gain) in volumes {
            mixer.set_gain(identity, *gain);
        }
    }

    /// New settings: the gate and volume at once, the processing and devices by restarting what changed.
    pub fn configure(&self, config: &VoiceConfig) -> Result<(), String> {
        let uplink = config.uplink();
        self.parts.control.set_config(uplink.clone());
        {
            let mut processing = lock(&self.parts.processing);
            if *processing != uplink.processing {
                *processing = uplink.processing;
                *lock(&self.parts.apm) = Apm::new(uplink.processing);
            }
        }
        let (input, output) = (config.input().map(str::to_string), config.output().map(str::to_string));
        let (input_changed, output_changed) = {
            let mut devices = lock(&self.parts.devices);
            let changed = (devices.0 != input, devices.1 != output);
            *devices = (input, output);
            changed
        };
        if output_changed {
            start_output(&self.parts)?;
        }
        if input_changed && lock(&self.parts.input).is_some() {
            start_input(&self.parts)?;
        }
        Ok(())
    }

    /// Leaves the room and stops every stream and task.
    pub async fn leave(mut self) {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        for (_, t) in lock(&self.parts.downlinks).drain() {
            t.abort();
        }
        let _ = self.room.close().await;
        *lock(&self.parts.input) = None;
        *lock(&self.parts.output) = None;
        *lock(&self.parts.publication) = None;
        lock(&self.parts.mixer).clear();
    }
}

/// Every frame cryptor of the own tracks sends with `index` (new cryptors start at index 0).
fn set_sending_index(room: &Room, index: i32) {
    let me = room.local_participant().identity();
    for ((identity, _), cryptor) in room.e2ee_manager().frame_cryptors() {
        if identity == me {
            cryptor.set_key_index(index);
        }
    }
}

/// Publishes the microphone, encrypted: the frame cryptor of the track must be active, else it goes away again.
async fn publish_mic(parts: &Arc<Parts>, room: &Arc<Room>) -> Result<(), String> {
    if lock(&parts.publication).is_some() {
        return Ok(());
    }
    let track = LocalAudioTrack::create_audio_track("microphone", RtcAudioSource::Native(parts.source.clone()));
    let options = TrackPublishOptions {
        source: TrackSource::Microphone,
        dtx: true,
        red: false,
        audio_encoding: Some(AudioEncoding { max_bitrate: u64::from(parts.bitrate_kbps) * 1000 }),
        ..Default::default()
    };
    let local = room.local_participant();
    let publication = tokio::time::timeout(E2EE_CONFIRM, local.publish_track(LocalTrack::Audio(track), options))
        .await
        .map_err(|_| "voice.publish_failed".to_string())?
        .map_err(|e| {
            eprintln!("tavrn: voice: publishing failed: {e}");
            "voice.publish_failed".to_string()
        })?;
    let encrypted = room.e2ee_manager().frame_cryptors().get(&(local.identity(), publication.sid())).is_some_and(|c| c.enabled());
    if !encrypted {
        let _ = local.unpublish_track(&publication.sid()).await;
        return Err("voice.e2ee_failed".into());
    }
    set_sending_index(room, parts.sending_index());
    if parts.control.muted.load(std::sync::atomic::Ordering::Acquire) {
        publication.mute();
    }
    *lock(&parts.publication) = Some(publication);
    start_input(parts)
}

/// (Re)starts the capture on the chosen input device.
fn start_input(parts: &Arc<Parts>) -> Result<(), String> {
    *lock(&parts.input) = None;
    let device = lock(&parts.devices).0.clone();
    let mut uplink = Uplink::new(Arc::clone(&parts.control));
    let apm = Arc::clone(&parts.apm);
    let source = parts.source.clone();
    let events = parts.events.clone();
    let stream = parts.io.start_input(
        device.as_deref(),
        Box::new(move |data, channels, rate| {
            let mut apm = lock(&apm);
            let processor = apm.as_mut().map(|a| a as &mut dyn Processor);
            uplink.push(
                data,
                channels,
                rate,
                processor,
                &mut |frame| {
                    let frame = AudioFrame { data: Cow::Borrowed(frame), sample_rate: RATE, num_channels: 1, samples_per_channel: FRAME as u32 };
                    // Unbuffered source: the frame goes to the encoder synchronously.
                    let _ = source.capture_frame(&frame).now_or_never();
                },
                &mut |report| {
                    let _ = events.send(match report {
                        UplinkReport::Level { level, open } => VoiceEvent::Level { level: finite(level), open },
                        UplinkReport::Ptt { open } => VoiceEvent::Ptt { open },
                    });
                },
            );
        }),
    )?;
    *lock(&parts.input) = Some(stream);
    Ok(())
}

/// (Re)starts the playback of the mix on the chosen output device; the mix is also the echo canceller's reference.
fn start_output(parts: &Arc<Parts>) -> Result<(), String> {
    *lock(&parts.output) = None;
    let device = lock(&parts.devices).1.clone();
    let mixer = Arc::clone(&parts.mixer);
    let apm = Arc::clone(&parts.apm);
    let mut fifo: VecDeque<f32> = VecDeque::new();
    let mut resampler: Option<(u32, Resampler)> = None;
    let mut block = vec![0.0f32; FRAME];
    let mut render = vec![0i16; FRAME];
    let mut converted = Vec::new();
    let mut mono = Vec::new();
    let stream = parts.io.start_output(
        device.as_deref(),
        Box::new(move |out, channels, rate| {
            let frames = out.len() / channels.max(1);
            let resampler = match &mut resampler {
                Some((r, s)) if *r == rate => s,
                slot => &mut slot.insert((rate, Resampler::new(RATE, rate))).1,
            };
            while fifo.len() < frames {
                lock(&mixer).mix(&mut block);
                if let Some(apm) = lock(&apm).as_mut() {
                    for (o, s) in render.iter_mut().zip(&block) {
                        *o = to_i16(*s);
                    }
                    apm.render(&mut render);
                }
                converted.clear();
                resampler.process(&block, &mut converted);
                fifo.extend(converted.iter());
            }
            mono.clear();
            mono.extend(fifo.drain(..frames));
            upmix(&mono, channels, out);
        }),
    )?;
    *lock(&parts.output) = Some(stream);
    Ok(())
}

/// The participants with their microphone state, the own device first.
fn participants(room: &Room) -> VoiceEvent {
    let mic_of = |pubs: Vec<TrackPublication>| pubs.into_iter().find(|p| p.source() == TrackSource::Microphone).map(|p| p.is_muted());
    let local = room.local_participant();
    let mut list = vec![{
        let mic = mic_of(local.track_publications().into_values().map(TrackPublication::Local).collect());
        ParticipantInfo { identity: local.identity().to_string(), mic: mic.is_some(), mic_muted: mic.unwrap_or(true), local: true }
    }];
    let mut remote: Vec<ParticipantInfo> = room
        .remote_participants()
        .into_values()
        .map(|p| {
            let mic = mic_of(p.track_publications().into_values().map(TrackPublication::Remote).collect());
            ParticipantInfo { identity: p.identity().to_string(), mic: mic.is_some(), mic_muted: mic.unwrap_or(true), local: false }
        })
        .collect();
    remote.sort_by(|a, b| a.identity.cmp(&b.identity));
    list.extend(remote);
    VoiceEvent::Participants { participants: list }
}

/// Whether this engine subscribes a remote track: audio only, as it plays no video (a camera would only cost download
/// bandwidth and decoding), and never a screen share's audio: streams are opt-in in tavrn (a viewer receives one only
/// after joining it) and cannot be joined without video.
fn wants_subscription(kind: TrackKind, source: TrackSource, name: &str) -> bool {
    name != "whisper" && kind == TrackKind::Audio && !matches!(source, TrackSource::Screenshare | TrackSource::ScreenshareAudio)
}

/// Brings a remote publication to the wanted subscription (the room connects without auto-subscription).
fn subscribe_wanted(publication: &RemoteTrackPublication) {
    let want = wants_subscription(publication.kind(), publication.source(), &publication.name());
    if publication.is_desired() != want {
        publication.set_subscribed(want);
    }
}

/// Plays a subscribed remote audio track: its decoded frames go into the mix.
fn start_downlink(parts: &Arc<Parts>, track: RemoteAudioTrack, sid: String, identity: String) {
    lock(&parts.mixer).add(&sid, &identity);
    let mixer = Arc::clone(&parts.mixer);
    let key = sid.clone();
    let task = tokio::spawn(async move {
        let mut stream = NativeAudioStream::new(track.rtc_track(), RATE as i32, 1);
        let mut samples = Vec::new();
        while let Some(frame) = stream.next().await {
            samples.clear();
            samples.extend(frame.data.iter().map(|s| from_i16(*s)));
            lock(&mixer).push(&key, &samples);
        }
    });
    if let Some(old) = lock(&parts.downlinks).insert(sid, task) {
        old.abort();
    }
}

fn stop_downlink(parts: &Parts, sid: &str) {
    if let Some(task) = lock(&parts.downlinks).remove(sid) {
        task.abort();
    }
    lock(&parts.mixer).remove(sid);
}

async fn handle(parts: &Arc<Parts>, room: &Arc<Room>, event: RoomEvent) {
    match event {
        RoomEvent::TrackSubscribed { publication, .. } if !wants_subscription(publication.kind(), publication.source(), &publication.name()) => {
            // Never played: whisper needs the browser engine's addressed receiver filter; video and screen shares are opt-in.
            publication.set_subscribed(false);
        }
        RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), publication, participant } => {
            start_downlink(parts, track, publication.sid().to_string(), participant.identity().to_string());
            parts.send(participants(room));
        }
        RoomEvent::TrackPublished { publication, .. } => {
            subscribe_wanted(&publication);
            parts.send(participants(room));
        }
        RoomEvent::TrackUnsubscribed { publication, .. } => {
            stop_downlink(parts, &publication.sid().to_string());
            parts.send(participants(room));
        }
        RoomEvent::ParticipantConnected(_)
        | RoomEvent::ParticipantDisconnected(_)
        | RoomEvent::TrackUnpublished { .. }
        | RoomEvent::TrackMuted { .. }
        | RoomEvent::TrackUnmuted { .. }
        | RoomEvent::LocalTrackPublished { .. } => parts.send(participants(room)),
        RoomEvent::LocalTrackUnpublished { publication, .. } => {
            let mut current = lock(&parts.publication);
            if current.as_ref().is_some_and(|p| p.sid() == publication.sid()) {
                *current = None;
                *lock(&parts.input) = None;
            }
            drop(current);
            parts.send(participants(room));
        }
        RoomEvent::LocalTrackRepublished { publication, .. } => {
            // A full reconnect re-issued the publication: the new cryptor sends with the current key, too.
            *lock(&parts.publication) = Some(publication);
            set_sending_index(room, parts.sending_index());
        }
        RoomEvent::ParticipantPermissionChanged { participant: Participant::Local(local), permission } => {
            let speak = can_speak!(permission);
            parts.send(VoiceEvent::Permissions { can_speak: speak });
            if speak && let Err(code) = publish_mic(parts, room).await {
                parts.send(VoiceEvent::Error { code });
            }
            let _ = local;
        }
        RoomEvent::ConnectionQualityChanged { quality, participant } => {
            parts.send(VoiceEvent::Quality { identity: participant.identity().to_string(), quality: quality_name(quality) });
        }
        RoomEvent::E2eeStateChanged { participant, state } => {
            parts.send(VoiceEvent::Encryption { identity: participant.identity().to_string(), state: encryption_name(state) });
        }
        RoomEvent::Reconnecting => parts.send(VoiceEvent::Reconnecting),
        RoomEvent::Reconnected => parts.send(VoiceEvent::Reconnected),
        RoomEvent::Disconnected { reason } => {
            *lock(&parts.input) = None;
            *lock(&parts.output) = None;
            parts.send(VoiceEvent::Disconnected { reason: reason_name(reason) });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_reasons_are_snake_case() {
        use livekit::DisconnectReason as R;
        assert_eq!(reason_name(R::ParticipantRemoved), "participant_removed");
        assert_eq!(reason_name(R::ClientInitiated), "client_initiated");
        assert_eq!(reason_name(R::RoomDeleted), "room_deleted");
        assert_eq!(reason_name(R::SignalClose), "signal_close");
    }

    #[test]
    fn the_microphone_needs_the_publish_grant() {
        assert!(may_publish_mic(true, &[]));
        assert!(may_publish_mic(true, &[PROTO_MICROPHONE]));
        assert!(!may_publish_mic(true, &[1]), "camera only");
        assert!(!may_publish_mic(false, &[]));
    }

    #[test]
    fn only_audio_is_subscribed_never_a_screen_share() {
        // Streams are opt-in (the web client's `streams.ts`); this engine plays no video, so it never joins one and
        // never receives a camera.
        assert!(wants_subscription(TrackKind::Audio, TrackSource::Microphone, "microphone"));
        assert!(!wants_subscription(TrackKind::Audio, TrackSource::Microphone, "whisper"));
        assert!(!wants_subscription(TrackKind::Audio, TrackSource::Unknown, "whisper"));
        assert!(wants_subscription(TrackKind::Audio, TrackSource::Unknown, "microphone"));
        assert!(!wants_subscription(TrackKind::Video, TrackSource::Camera, "microphone"));
        assert!(!wants_subscription(TrackKind::Video, TrackSource::Unknown, "microphone"));
        assert!(!wants_subscription(TrackKind::Video, TrackSource::Screenshare, "microphone"));
        assert!(!wants_subscription(TrackKind::Audio, TrackSource::ScreenshareAudio, "microphone"));
    }
}
