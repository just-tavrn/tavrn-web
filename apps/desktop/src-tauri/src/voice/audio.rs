// SPDX-License-Identifier: Apache-2.0
//! Audio devices of the native engine through cpal: PulseAudio (also PipeWire's PulseAudio server) or ALSA on
//! Linux, WASAPI on Windows. The engine sees mono 48 kHz frames only (`uplink.rs`, `mix.rs`); this module opens the
//! chosen device in whatever format it offers (48 kHz preferred), converts and hands the samples over. A fake
//! backend (a generated tone in, a level meter out, both in real time) serves the tests and the voice end-to-end test
//! of the built app on machines without sound hardware (`TAVRN_DESKTOP_FAKE_AUDIO=1`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::dsp::RATE;

/// A device as the settings list it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Device {
    /// Stable id to keep in the settings (cpal's `<host>:<id>`).
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Devices {
    pub inputs: Vec<Device>,
    pub outputs: Vec<Device>,
}

/// Interleaved samples of the capture with their channel count and rate.
pub type InputFn = Box<dyn FnMut(&[f32], usize, u32) + Send>;
/// Fills an interleaved output block of the given channel count and rate.
pub type OutputFn = Box<dyn FnMut(&mut [f32], usize, u32) + Send>;
/// A running stream; dropping it stops the stream.
pub type StreamHandle = Box<dyn Send>;

/// Where the engine's audio comes from and goes to.
pub trait AudioIo: Send + Sync {
    fn devices(&self) -> Devices;
    /// Opens the input `device` (`None` or an unknown id: the system default).
    fn start_input(&self, device: Option<&str>, on_data: InputFn) -> Result<StreamHandle, String>;
    fn start_output(&self, device: Option<&str>, fill: OutputFn) -> Result<StreamHandle, String>;
}

/// The audio backend of the app: the fake one when `TAVRN_DESKTOP_FAKE_AUDIO=1`, else the system's.
pub fn from_env() -> Arc<dyn AudioIo> {
    if std::env::var("TAVRN_DESKTOP_FAKE_AUDIO").is_ok_and(|v| v == "1") { Arc::new(FakeIo::default()) } else { Arc::new(SystemIo) }
}

// ---------------------------------------------------------------------------------------------- system devices

#[cfg(feature = "native-voice")]
pub use system::SystemIo;

#[cfg(feature = "native-voice")]
mod system {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{DeviceId, SampleFormat, StreamConfig, SupportedStreamConfig};

    use super::*;

    /// The system's devices (cpal's default host: PulseAudio when it runs, else ALSA; WASAPI on Windows).
    pub struct SystemIo;

    /// cpal's stream is not `Send` on every platform; it is created, kept and dropped by the engine only.
    struct Kept(#[allow(dead_code)] cpal::Stream);
    // SAFETY: the stream is only moved between the engine's threads and dropped once; it is never used concurrently.
    unsafe impl Send for Kept {}

    fn label(d: &cpal::Device) -> String {
        d.description().map(|desc| desc.name().to_string()).unwrap_or_else(|_| "Audio device".into())
    }

    fn list(devices: Result<impl Iterator<Item = cpal::Device>, cpal::Error>) -> Vec<Device> {
        let Ok(devices) = devices else { return Vec::new() };
        devices.filter_map(|d| Some(Device { id: d.id().ok()?.to_string(), label: label(&d) })).take(64).collect()
    }

    fn find(host: &cpal::Host, id: Option<&str>, input: bool) -> Option<cpal::Device> {
        let chosen = id.and_then(|id| id.parse::<DeviceId>().ok()).and_then(|id| host.device_by_id(&id));
        chosen.or_else(|| if input { host.default_input_device() } else { host.default_output_device() })
    }

    /// 48 kHz in f32 or i16 when the device offers it, else its default format.
    fn choose(ranges: Vec<cpal::SupportedStreamConfigRange>, fallback: Result<SupportedStreamConfig, cpal::Error>) -> Result<SupportedStreamConfig, String> {
        let usable = |f: SampleFormat| matches!(f, SampleFormat::F32 | SampleFormat::I16);
        let preferred = ranges
            .into_iter()
            .filter(|r| usable(r.sample_format()) && r.channels() <= 2)
            .filter_map(|r| r.try_with_sample_rate(RATE))
            .min_by_key(|c| c.channels());
        match preferred {
            Some(c) => Ok(c),
            None => fallback.map_err(|e| e.to_string()).and_then(|c| if usable(c.sample_format()) { Ok(c) } else { Err("voice.device_format".into()) }),
        }
    }

    impl AudioIo for SystemIo {
        fn devices(&self) -> Devices {
            let host = cpal::default_host();
            Devices { inputs: list(host.input_devices()), outputs: list(host.output_devices()) }
        }

        fn start_input(&self, device: Option<&str>, mut on_data: InputFn) -> Result<StreamHandle, String> {
            let host = cpal::default_host();
            let device = find(&host, device, true).ok_or("voice.no_input")?;
            let ranges = device.supported_input_configs().map(|r| r.collect()).unwrap_or_default();
            let supported = choose(ranges, device.default_input_config())?;
            let config: StreamConfig = supported.config();
            let (channels, rate) = (usize::from(config.channels), config.sample_rate);
            let err = |e: cpal::Error| eprintln!("tavrn: voice input: {e}");
            let stream = match supported.sample_format() {
                SampleFormat::F32 => device.build_input_stream::<f32, _, _>(config, move |data, _| on_data(data, channels, rate), err, None),
                _ => {
                    let mut buf = Vec::new();
                    device.build_input_stream::<i16, _, _>(
                        config,
                        move |data, _| {
                            buf.clear();
                            buf.extend(data.iter().map(|s| super::super::dsp::from_i16(*s)));
                            on_data(&buf, channels, rate);
                        },
                        err,
                        None,
                    )
                }
            }
            .map_err(|e| format!("voice.input_failed: {e}"))?;
            stream.play().map_err(|e| format!("voice.input_failed: {e}"))?;
            Ok(Box::new(Kept(stream)))
        }

        fn start_output(&self, device: Option<&str>, mut fill: OutputFn) -> Result<StreamHandle, String> {
            let host = cpal::default_host();
            let device = find(&host, device, false).ok_or("voice.no_output")?;
            let ranges = device.supported_output_configs().map(|r| r.collect()).unwrap_or_default();
            let supported = choose(ranges, device.default_output_config())?;
            let config: StreamConfig = supported.config();
            let (channels, rate) = (usize::from(config.channels), config.sample_rate);
            let err = |e: cpal::Error| eprintln!("tavrn: voice output: {e}");
            let stream = match supported.sample_format() {
                SampleFormat::F32 => device.build_output_stream::<f32, _, _>(config, move |data, _| fill(data, channels, rate), err, None),
                _ => {
                    let mut buf = Vec::new();
                    device.build_output_stream::<i16, _, _>(
                        config,
                        move |data, _| {
                            buf.resize(data.len(), 0.0);
                            fill(&mut buf, channels, rate);
                            for (o, s) in data.iter_mut().zip(&buf) {
                                *o = super::super::dsp::to_i16(*s);
                            }
                        },
                        err,
                        None,
                    )
                }
            }
            .map_err(|e| format!("voice.output_failed: {e}"))?;
            stream.play().map_err(|e| format!("voice.output_failed: {e}"))?;
            Ok(Box::new(Kept(stream)))
        }
    }
}

/// Without the native engine there are no devices.
#[cfg(not(feature = "native-voice"))]
pub struct SystemIo;

#[cfg(not(feature = "native-voice"))]
impl AudioIo for SystemIo {
    fn devices(&self) -> Devices {
        Devices::default()
    }
    fn start_input(&self, _: Option<&str>, _: InputFn) -> Result<StreamHandle, String> {
        Err("voice.native_unavailable".into())
    }
    fn start_output(&self, _: Option<&str>, _: OutputFn) -> Result<StreamHandle, String> {
        Err("voice.native_unavailable".into())
    }
}

// ---------------------------------------------------------------------------------------------- fake devices

/// The test backend: the input is a 440 Hz tone (amplitude `tone`, 0 = silence), the output is consumed in real time
/// and its loudest 10 ms RMS (dBFS) is kept per 100 ms window in `levels`.
pub struct FakeIo {
    pub tone: Arc<Mutex<f32>>,
    pub levels: Arc<Mutex<Vec<f64>>>,
}

impl Default for FakeIo {
    fn default() -> Self {
        Self { tone: Arc::new(Mutex::new(0.25)), levels: Arc::default() }
    }
}

/// Stops its thread when dropped.
struct FakeStream(Arc<AtomicBool>);

impl Drop for FakeStream {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Runs `tick` every 10 ms (catching up after a late wake-up) until the stream is dropped.
fn realtime(name: &str, mut tick: impl FnMut() + Send + 'static) -> Result<StreamHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let start = Instant::now();
            let mut n: u32 = 0;
            while !flag.load(Ordering::Relaxed) {
                tick();
                n += 1;
                let next = start + Duration::from_millis(10) * n;
                if let Some(wait) = next.checked_duration_since(Instant::now()) {
                    thread::sleep(wait);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Box::new(FakeStream(stop)))
}

impl AudioIo for FakeIo {
    fn devices(&self) -> Devices {
        Devices {
            inputs: vec![Device { id: "fake:tone".into(), label: "Test tone".into() }],
            outputs: vec![Device { id: "fake:meter".into(), label: "Level meter".into() }],
        }
    }

    fn start_input(&self, _: Option<&str>, mut on_data: InputFn) -> Result<StreamHandle, String> {
        let tone = Arc::clone(&self.tone);
        let mut phase = 0.0f32;
        let step = 2.0 * std::f32::consts::PI * 440.0 / RATE as f32;
        let mut block = vec![0.0f32; (RATE / 100) as usize];
        realtime("tavrn-fake-input", move || {
            let a = tone.lock().map(|t| *t).unwrap_or(0.0);
            for s in block.iter_mut() {
                *s = a * phase.sin();
                phase = (phase + step) % (2.0 * std::f32::consts::PI);
            }
            on_data(&block, 1, RATE);
        })
    }

    fn start_output(&self, _: Option<&str>, mut fill: OutputFn) -> Result<StreamHandle, String> {
        let levels = Arc::clone(&self.levels);
        let mut block = vec![0.0f32; (RATE / 100) as usize];
        let mut window = f64::NEG_INFINITY;
        let mut count = 0;
        realtime("tavrn-fake-output", move || {
            fill(&mut block, 1, RATE);
            window = window.max(super::gate::dbfs(&block));
            count += 1;
            if count == 10 {
                if let Ok(mut l) = levels.lock() {
                    l.push(window);
                    // Keep the last minute.
                    let excess = l.len().saturating_sub(600);
                    l.drain(..excess);
                }
                window = f64::NEG_INFINITY;
                count = 0;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fake_backend_plays_a_tone_and_meters_the_output() -> Result<(), String> {
        let io = FakeIo::default();
        let got = Arc::new(Mutex::new(Vec::<f32>::new()));
        let sink = Arc::clone(&got);
        let input = io.start_input(
            None,
            Box::new(move |d, ch, rate| {
                assert_eq!((ch, rate), (1, RATE));
                if let Ok(mut g) = sink.lock() {
                    g.extend_from_slice(d);
                }
            }),
        )?;
        let output = io.start_output(None, Box::new(|out, _, _| out.fill(0.1)))?;
        thread::sleep(Duration::from_millis(250));
        drop(input);
        drop(output);
        let samples = got.lock().map(|g| g.len()).unwrap_or(0);
        assert!(samples >= 480 * 10, "{samples} samples in 250 ms");
        let levels = io.levels.lock().map(|l| l.clone()).unwrap_or_default();
        assert!(!levels.is_empty());
        assert!(levels.iter().all(|l| (l + 20.0).abs() < 0.01), "{levels:?}");
        assert_eq!(io.devices().inputs.len(), 1);
        Ok(())
    }
}
