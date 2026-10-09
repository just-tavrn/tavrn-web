// SPDX-License-Identifier: Apache-2.0
//! The microphone path of the native engine, in the order of the web client's pipeline (`audio.ts`):
//!
//!   device ─▶ mono, 48 kHz ─▶ 10 ms frames ─▶ echo cancellation / noise suppression / auto gain (WebRTC's audio
//!   processing, as the browser's capture constraints) ─▶ input volume ─▶ gate (voice activation / push-to-talk)
//!   ─▶ the published track
//!
//! The settings and the push-to-talk state come from [`Control`], which the commands and the hotkey listener change
//! from other threads; the uplink reads it once per frame. Reports (the level about ten times per second and at once
//! when the gate opens or closes, push-to-talk opening and closing after its release delay) go back as
//! [`UplinkReport`]s.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use super::dsp::{FRAME, RATE, Resampler, downmix, from_i16, to_i16};
use super::gate::{Gate, LevelMeter, gate_mode_for};

/// The microphone settings of the engine (the web client's voice settings, `settings.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct UplinkConfig {
    /// Input volume, 1.0 = 100 % (0…2).
    pub input_gain: f32,
    /// Voice activation / noise gate threshold in dBFS (`gateThreshold` of the web client; `None`: no gate).
    pub threshold: Option<f64>,
    pub hold_ms: u32,
    /// Push-to-talk instead of voice activation.
    pub ptt_mode: bool,
    pub ptt_release_ms: u32,
    pub processing: Processing,
}

impl Default for UplinkConfig {
    fn default() -> Self {
        Self { input_gain: 1.0, threshold: Some(-55.0), hold_ms: 300, ptt_mode: false, ptt_release_ms: 250, processing: Processing::default() }
    }
}

/// WebRTC's audio processing of the capture (the browser's `echoCancellation`, `noiseSuppression`, `autoGainControl`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Processing {
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain: bool,
}

impl Default for Processing {
    fn default() -> Self {
        Self { echo_cancellation: true, noise_suppression: true, auto_gain: true }
    }
}

impl Processing {
    pub fn any(&self) -> bool {
        self.echo_cancellation || self.noise_suppression || self.auto_gain
    }
}

/// Shared state of the microphone path: written by commands and hotkeys, read by the capture thread.
#[derive(Debug, Default)]
pub struct Control {
    pub muted: AtomicBool,
    pub ptt_held: AtomicBool,
    config: Mutex<UplinkConfig>,
    generation: AtomicU64,
}

impl Control {
    pub fn set_config(&self, config: UplinkConfig) {
        if let Ok(mut c) = self.config.lock() {
            *c = config;
        }
        self.generation.fetch_add(1, Ordering::Release);
    }

    pub fn config(&self) -> UplinkConfig {
        self.config.lock().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn set_ptt(&self, held: bool) {
        self.ptt_held.store(held, Ordering::Release);
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Release);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum UplinkReport {
    /// dBFS of the loudest frame of the last ~100 ms (before the gate) and whether the gate lets the voice through.
    Level { level: f64, open: bool },
    /// Push-to-talk opened (key down) or closed (after the release delay).
    Ptt { open: bool },
}

/// The audio processing in front of the gate (WebRTC's APM in the app, nothing in some tests).
pub trait Processor: Send {
    /// One 10 ms frame of the capture (48 kHz mono), processed in place.
    fn capture(&mut self, frame: &mut [i16]);
}

pub struct Uplink {
    control: std::sync::Arc<Control>,
    generation: u64,
    config: UplinkConfig,
    resampler: Option<(u32, Resampler)>,
    mono: Vec<f32>,
    resampled: Vec<f32>,
    pending: Vec<f32>,
    frame_i16: Vec<i16>,
    frame: Vec<f32>,
    gate: Gate,
    meter: LevelMeter,
    was_open: bool,
    ptt_open: bool,
    release_left: i64,
    was_muted: bool,
}

impl Uplink {
    pub fn new(control: std::sync::Arc<Control>) -> Self {
        let config = control.config();
        let mut uplink = Self {
            control,
            generation: u64::MAX,
            config,
            resampler: None,
            mono: Vec::new(),
            resampled: Vec::new(),
            pending: Vec::new(),
            frame_i16: vec![0; FRAME],
            frame: vec![0.0; FRAME],
            gate: Gate::new(RATE),
            meter: LevelMeter::new(RATE, FRAME as u32),
            was_open: false,
            ptt_open: false,
            release_left: 0,
            was_muted: false,
        };
        uplink.refresh();
        uplink
    }

    fn refresh(&mut self) {
        let generation = self.control.generation.load(Ordering::Acquire);
        if generation == self.generation {
            return;
        }
        self.generation = generation;
        self.config = self.control.config();
        self.gate.configure(self.config.threshold, if self.config.ptt_mode { 0 } else { self.config.hold_ms });
    }

    /// Feeds captured samples (interleaved, any channel count and rate). Every complete 10 ms frame is processed and
    /// handed to `send`; reports go to `report`. Muted, nothing is processed or sent.
    pub fn push(&mut self, input: &[f32], channels: usize, rate: u32, mut processor: Option<&mut dyn Processor>, send: &mut dyn FnMut(&[i16]), report: &mut dyn FnMut(UplinkReport)) {
        self.refresh();
        let muted = self.control.muted.load(Ordering::Acquire);
        if muted {
            if !self.was_muted {
                self.pending.clear();
                self.was_open = false;
            }
            self.was_muted = true;
            return;
        }
        self.was_muted = false;
        self.mono.clear();
        downmix(input, channels, &mut self.mono);
        let resampler = match &mut self.resampler {
            Some((r, s)) if *r == rate => s,
            slot => &mut slot.insert((rate, Resampler::new(rate, RATE))).1,
        };
        self.resampled.clear();
        resampler.process(&self.mono, &mut self.resampled);
        self.pending.extend_from_slice(&self.resampled);
        while self.pending.len() >= FRAME {
            self.frame.copy_from_slice(&self.pending[..FRAME]);
            self.pending.drain(..FRAME);
            self.process_frame(&mut processor, send, report);
        }
    }

    fn process_frame(&mut self, processor: &mut Option<&mut dyn Processor>, send: &mut dyn FnMut(&[i16]), report: &mut dyn FnMut(UplinkReport)) {
        if let Some(p) = processor.as_mut() {
            for (o, s) in self.frame_i16.iter_mut().zip(&self.frame) {
                *o = to_i16(*s);
            }
            p.capture(&mut self.frame_i16);
            for (o, s) in self.frame.iter_mut().zip(&self.frame_i16) {
                *o = from_i16(*s);
            }
        }
        let gain = self.config.input_gain;
        if gain != 1.0 {
            for s in self.frame.iter_mut() {
                *s *= gain;
            }
        }
        self.update_ptt(report);
        self.gate.mode = gate_mode_for(self.config.ptt_mode, self.ptt_open);
        let level = self.gate.process(&mut self.frame);
        for (o, s) in self.frame_i16.iter_mut().zip(&self.frame) {
            *o = to_i16(*s);
        }
        send(&self.frame_i16);
        let open = self.gate.open();
        let window = self.meter.push(level);
        if window.is_some() || open != self.was_open {
            self.was_open = open;
            report(UplinkReport::Level { level: window.unwrap_or(level), open });
        }
    }

    /// Push-to-talk: the key opens at once; after the release the gate stays open for the release delay. Outside
    /// push-to-talk mode it is closed.
    fn update_ptt(&mut self, report: &mut dyn FnMut(UplinkReport)) {
        let held = self.config.ptt_mode && self.control.ptt_held.load(Ordering::Acquire);
        let open = if held {
            self.release_left = i64::from(self.config.ptt_release_ms) * i64::from(RATE) / 1000;
            true
        } else if self.ptt_open && self.config.ptt_mode {
            self.release_left -= FRAME as i64;
            self.release_left > 0
        } else {
            false
        };
        if open != self.ptt_open {
            self.ptt_open = open;
            report(UplinkReport::Ptt { open });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn sine(rate: u32, channels: usize, ms: u32, amp: f32) -> Vec<f32> {
        let n = (rate * ms / 1000) as usize;
        (0..n).flat_map(|i| std::iter::repeat_n(amp * (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / rate as f32).sin(), channels)).collect()
    }

    struct Run {
        frames: Vec<Vec<i16>>,
        reports: Vec<UplinkReport>,
    }

    fn run(uplink: &mut Uplink, input: &[f32], channels: usize, rate: u32) -> Run {
        let mut frames = Vec::new();
        let mut reports = Vec::new();
        uplink.push(input, channels, rate, None, &mut |f| frames.push(f.to_vec()), &mut |r| reports.push(r));
        Run { frames, reports }
    }

    fn peak(frames: &[Vec<i16>]) -> i16 {
        frames.iter().flatten().map(|s| s.saturating_abs()).max().unwrap_or(0)
    }

    #[test]
    fn any_device_format_becomes_10_ms_frames_at_48_khz() {
        for (rate, channels) in [(48_000, 1), (44_100, 2), (16_000, 1)] {
            let control = Arc::new(Control::default());
            control.set_config(UplinkConfig { threshold: None, ..UplinkConfig::default() });
            let mut up = Uplink::new(control);
            let out = run(&mut up, &sine(rate, channels, 1000, 0.5), channels, rate);
            assert!((99..=100).contains(&out.frames.len()), "{rate}/{channels}: {}", out.frames.len());
            assert!(out.frames.iter().all(|f| f.len() == FRAME));
            assert!(peak(&out.frames) > 10_000, "{rate}/{channels}");
        }
    }

    #[test]
    fn voice_activation_sends_silence_below_the_threshold() {
        let control = Arc::new(Control::default());
        control.set_config(UplinkConfig { threshold: Some(-30.0), ..UplinkConfig::default() });
        let mut up = Uplink::new(Arc::clone(&control));
        let quiet = run(&mut up, &sine(48_000, 1, 500, 0.001), 1, 48_000);
        assert_eq!(peak(&quiet.frames), 0, "silence below the threshold");
        assert!(quiet.reports.iter().all(|r| matches!(r, UplinkReport::Level { open: false, .. })));
        // About ten level reports per second.
        assert_eq!(quiet.reports.len(), 5);
        let loud = run(&mut up, &sine(48_000, 1, 100, 0.5), 1, 48_000);
        assert!(peak(&loud.frames) > 10_000);
        assert!(matches!(loud.reports.first(), Some(UplinkReport::Level { open: true, .. })), "the opening is reported at once");
    }

    #[test]
    fn the_input_volume_scales_before_the_gate() {
        let control = Arc::new(Control::default());
        control.set_config(UplinkConfig { threshold: Some(-30.0), input_gain: 0.0, ..UplinkConfig::default() });
        let mut up = Uplink::new(Arc::clone(&control));
        assert_eq!(peak(&run(&mut up, &sine(48_000, 1, 200, 0.5), 1, 48_000).frames), 0);
        control.set_config(UplinkConfig { threshold: None, input_gain: 2.0, ..UplinkConfig::default() });
        assert!(peak(&run(&mut up, &sine(48_000, 1, 200, 0.25), 1, 48_000).frames) > 15_000);
    }

    #[test]
    fn push_to_talk_opens_with_the_key_and_closes_after_the_release_delay() {
        let control = Arc::new(Control::default());
        control.set_config(UplinkConfig { ptt_mode: true, ptt_release_ms: 100, threshold: None, ..UplinkConfig::default() });
        let mut up = Uplink::new(Arc::clone(&control));
        let tone = sine(48_000, 1, 100, 0.5);
        assert_eq!(peak(&run(&mut up, &tone, 1, 48_000).frames), 0, "closed without the key");
        control.set_ptt(true);
        let held = run(&mut up, &tone, 1, 48_000);
        assert!(held.reports.contains(&UplinkReport::Ptt { open: true }));
        assert!(peak(&held.frames) > 10_000);
        control.set_ptt(false);
        // 100 ms release delay: still open for the first 9 frames, closed at the 10th.
        let released = run(&mut up, &sine(48_000, 1, 200, 0.5), 1, 48_000);
        let closed_at = released.reports.iter().position(|r| *r == UplinkReport::Ptt { open: false });
        assert!(closed_at.is_some(), "{:?}", released.reports);
        assert!(peak(&released.frames[..9]) > 10_000);
        assert_eq!(peak(&released.frames[15..]), 0);
    }

    #[test]
    fn muted_nothing_is_sent() {
        let control = Arc::new(Control::default());
        control.set_config(UplinkConfig { threshold: None, ..UplinkConfig::default() });
        control.set_muted(true);
        let mut up = Uplink::new(Arc::clone(&control));
        let out = run(&mut up, &sine(48_000, 1, 200, 0.5), 1, 48_000);
        assert!(out.frames.is_empty() && out.reports.is_empty());
        control.set_muted(false);
        assert_eq!(run(&mut up, &sine(48_000, 1, 200, 0.5), 1, 48_000).frames.len(), 20);
    }

    struct Halve;
    impl Processor for Halve {
        fn capture(&mut self, frame: &mut [i16]) {
            for s in frame.iter_mut() {
                *s /= 2;
            }
        }
    }

    #[test]
    fn the_processor_runs_before_the_gain() {
        let control = Arc::new(Control::default());
        control.set_config(UplinkConfig { threshold: None, input_gain: 1.0, ..UplinkConfig::default() });
        let mut up = Uplink::new(control);
        let mut frames = Vec::new();
        let mut p = Halve;
        up.push(&sine(48_000, 1, 100, 0.8), 1, 48_000, Some(&mut p), &mut |f| frames.push(f.to_vec()), &mut |_| {});
        let max = peak(&frames);
        assert!((12_000..14_000).contains(&max), "{max}");
    }
}
