// SPDX-License-Identifier: Apache-2.0
//! Noise gate, voice activation and push-to-talk of the native engine: the same DSP as the web client's gate
//! (`web/src/voice/gate.ts`, design note 4.9), so a threshold means the same in both engines. A threshold in dBFS
//! opens the gate, it closes 6 dB below it after the hold time; the gain ramps up in 5 ms and down in 40 ms. The level
//! meter keeps the loudest block of about 100 ms. Pure, no audio I/O.

/// What decides the gate: voice activation (`Auto`), or push-to-talk holding it open or closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateMode {
    Auto,
    Open,
    Closed,
}

/// The gate mode for the input mode and the push-to-talk state (`gateModeFor` of the web client, without the
/// microphone test, which the native engine does not have).
pub fn gate_mode_for(ptt_mode: bool, ptt_open: bool) -> GateMode {
    match (ptt_mode, ptt_open) {
        (false, _) => GateMode::Auto,
        (true, true) => GateMode::Open,
        (true, false) => GateMode::Closed,
    }
}

/// RMS level of a block in dBFS (`-inf` for digital silence).
pub fn dbfs(block: &[f32]) -> f64 {
    let sum: f64 = block.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    if sum == 0.0 || block.is_empty() {
        return f64::NEG_INFINITY;
    }
    10.0 * (sum / block.len() as f64).log10()
}

/// The gate closes this far below the open threshold (no fluttering around the threshold).
const HYSTERESIS_DB: f64 = 6.0;
/// Gain ramps (per sample, linear): fast attack so syllables are not cut, slower release.
const ATTACK_MS: f64 = 5.0;
const RELEASE_MS: f64 = 40.0;

#[derive(Debug, Clone)]
pub struct Gate {
    pub mode: GateMode,
    sample_rate: u32,
    threshold: Option<f64>,
    hold_samples: f64,
    since: f64,
    target: f32,
    gain: f32,
    attack: f32,
    release: f32,
}

impl Gate {
    pub fn new(sample_rate: u32) -> Self {
        let rate = f64::from(sample_rate);
        Self {
            mode: GateMode::Auto,
            sample_rate,
            threshold: None,
            hold_samples: 0.0,
            since: f64::INFINITY,
            target: 0.0,
            gain: 0.0,
            attack: (1.0 / (ATTACK_MS / 1000.0 * rate)) as f32,
            release: (1.0 / (RELEASE_MS / 1000.0 * rate)) as f32,
        }
    }

    /// The voice activation threshold (dBFS; `None`: no gate, always open in `Auto`) and the hold time.
    pub fn configure(&mut self, threshold: Option<f64>, hold_ms: u32) {
        self.threshold = threshold;
        self.hold_samples = (f64::from(hold_ms) / 1000.0 * f64::from(self.sample_rate)).max(0.0);
    }

    /// Whether the gate is (being) opened.
    pub fn open(&self) -> bool {
        self.target == 1.0
    }

    /// Gates one block in place; returns its level in dBFS (measured before the gate).
    pub fn process(&mut self, block: &mut [f32]) -> f64 {
        let level = dbfs(block);
        self.decide(level, block.len());
        for s in block.iter_mut() {
            *s *= self.step();
        }
        level
    }

    fn step(&mut self) -> f32 {
        if self.gain < self.target {
            self.gain = (self.gain + self.attack).min(1.0);
        } else if self.gain > self.target {
            self.gain = (self.gain - self.release).max(0.0);
        }
        self.gain
    }

    fn decide(&mut self, level: f64, samples: usize) {
        let threshold = match (self.mode, self.threshold) {
            (GateMode::Auto, Some(t)) => t,
            (mode, _) => {
                self.target = if mode == GateMode::Closed { 0.0 } else { 1.0 };
                self.since = 0.0;
                return;
            }
        };
        if level >= threshold || (self.target == 1.0 && level >= threshold - HYSTERESIS_DB) {
            self.target = 1.0;
            self.since = 0.0;
            return;
        }
        self.since += samples as f64;
        if self.since > self.hold_samples {
            self.target = 0.0;
        }
    }
}

/// Keeps the loudest block level of a ~100 ms window and hands it out once per window.
#[derive(Debug, Clone)]
pub struct LevelMeter {
    every: u32,
    count: u32,
    max: f64,
}

impl LevelMeter {
    pub fn new(sample_rate: u32, block_size: u32) -> Self {
        let every = ((f64::from(sample_rate) * 0.1) / f64::from(block_size.max(1))).round().max(1.0) as u32;
        Self { every, count: 0, max: f64::NEG_INFINITY }
    }

    pub fn push(&mut self, level: f64) -> Option<f64> {
        if level > self.max {
            self.max = level;
        }
        self.count += 1;
        if self.count < self.every {
            return None;
        }
        let out = self.max;
        self.count = 0;
        self.max = f64::NEG_INFINITY;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;
    const BLOCK: usize = 480;

    fn tone(db: f64) -> Vec<f32> {
        // A square wave of amplitude a has an RMS of a: a = 10^(db/20).
        let a = 10f64.powf(db / 20.0) as f32;
        (0..BLOCK).map(|i| if i % 2 == 0 { a } else { -a }).collect()
    }

    fn run(gate: &mut Gate, db: f64, blocks: usize) -> f32 {
        let mut last = 0.0;
        for _ in 0..blocks {
            let mut b = tone(db);
            gate.process(&mut b);
            last = b.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        }
        last
    }

    #[test]
    fn dbfs_matches_the_web_client() {
        assert_eq!(dbfs(&[0.0; 16]), f64::NEG_INFINITY);
        assert!((dbfs(&tone(-20.0)) + 20.0).abs() < 1e-6);
        assert!((dbfs(&[1.0, -1.0]) - 0.0).abs() < 1e-9);
    }

    #[test]
    fn voice_activation_opens_above_the_threshold_and_closes_after_the_hold() {
        let mut g = Gate::new(RATE);
        g.configure(Some(-40.0), 300);
        assert!(run(&mut g, -60.0, 5) == 0.0, "below the threshold nothing passes");
        assert!(!g.open());
        assert!(run(&mut g, -30.0, 2) > 0.0);
        assert!(g.open());
        // Within the hysteresis (-44 dB is above -46 dB) the gate stays open however long.
        run(&mut g, -44.0, 100);
        assert!(g.open());
        // Below it the hold of 300 ms (30 blocks of 10 ms) keeps it open, then it closes.
        run(&mut g, -60.0, 30);
        assert!(g.open());
        run(&mut g, -60.0, 2);
        assert!(!g.open());
        assert_eq!(run(&mut g, -60.0, 10), 0.0, "the release ramp reaches zero");
    }

    #[test]
    fn the_attack_is_fast_and_the_release_slow() {
        let mut g = Gate::new(RATE);
        g.configure(Some(-40.0), 0);
        let mut b = tone(-20.0);
        g.process(&mut b);
        // 5 ms attack = 240 samples: the first block of 480 samples reaches full gain.
        assert!((b[BLOCK - 1].abs() - tone(-20.0)[0].abs()).abs() < 1e-6);
        let mut quiet = tone(-80.0);
        g.process(&mut quiet);
        // 40 ms release: after 10 ms about three quarters of the gain remain.
        let ratio = quiet[BLOCK - 1].abs() / tone(-80.0)[0].abs();
        assert!((0.70..0.80).contains(&ratio), "{ratio}");
    }

    #[test]
    fn push_to_talk_ignores_the_level() {
        let mut g = Gate::new(RATE);
        g.configure(Some(-40.0), 300);
        g.mode = gate_mode_for(true, false);
        assert_eq!(run(&mut g, -10.0, 5), 0.0);
        g.mode = gate_mode_for(true, true);
        assert!(run(&mut g, -90.0, 2) > 0.0);
        assert!(g.open());
        assert_eq!(gate_mode_for(false, true), GateMode::Auto);
    }

    #[test]
    fn without_a_threshold_voice_activation_is_always_open() {
        let mut g = Gate::new(RATE);
        g.configure(None, 0);
        assert!(run(&mut g, -90.0, 2) > 0.0);
        assert!(g.open());
    }

    #[test]
    fn the_meter_reports_the_loudest_block_every_100_ms() {
        let mut m = LevelMeter::new(RATE, 480);
        let mut out = Vec::new();
        for i in 0..20 {
            if let Some(v) = m.push(-60.0 + f64::from(i % 10)) {
                out.push(v);
            }
        }
        assert_eq!(out, vec![-51.0, -51.0]);
    }
}
