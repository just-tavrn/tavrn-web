// SPDX-License-Identifier: Apache-2.0
//! Small sample helpers of the native engine: channel conversion, a linear resampler between the device's rate
//! and the engine's 48 kHz, and the f32/i16 conversion of LiveKit's frames. Pure, no audio I/O.

/// The engine's sample rate (Opus, the web client's AudioContext).
pub const RATE: u32 = 48_000;
/// One frame of the engine: 10 ms at 48 kHz, mono.
pub const FRAME: usize = (RATE / 100) as usize;

/// The average of the channels of an interleaved block.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    let channels = channels.max(1);
    out.extend(interleaved.chunks(channels).map(|c| c.iter().sum::<f32>() / c.len() as f32));
}

/// A mono block on every channel of an interleaved output block (`out.len()` = frames × channels).
pub fn upmix(mono: &[f32], channels: usize, out: &mut [f32]) {
    let channels = channels.max(1);
    for (frame, s) in out.chunks_mut(channels).zip(mono) {
        frame.fill(*s);
    }
}

pub fn to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
}

pub fn from_i16(s: i16) -> f32 {
    f32::from(s) / f32::from(i16::MAX)
}

/// Linear interpolation between two rates, block by block (state carries over between blocks). Good enough for
/// speech between common device rates and 48 kHz; the same rate passes through unchanged.
#[derive(Debug, Clone)]
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Position of the next output sample, relative to `prev` (0 = prev, 1 = the first sample of the next block).
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self { step: f64::from(from.max(1)) / f64::from(to.max(1)), pos: 1.0, prev: 0.0 }
    }

    pub fn passthrough(&self) -> bool {
        self.step == 1.0
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough() {
            out.extend_from_slice(input);
            return;
        }
        // Sample i of the input sits at position i + 1 (prev at 0).
        let n = input.len() as f64;
        while self.pos <= n {
            let i = self.pos.floor();
            let frac = (self.pos - i) as f32;
            let at = |k: f64| if k < 1.0 { self.prev } else { input[(k as usize) - 1] };
            let a = at(i);
            let b = if frac == 0.0 { a } else { at(i + 1.0) };
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= n;
        if let Some(last) = input.last() {
            self.prev = *last;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_mix_down_and_up() {
        let mut mono = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, -1.0], 2, &mut mono);
        assert_eq!(mono, vec![0.5, 0.5, -1.0]);
        let mut out = vec![0.0; 6];
        upmix(&mono, 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5, 0.5, 0.5, -1.0, -1.0]);
        let mut same = Vec::new();
        downmix(&[0.25, 0.75], 1, &mut same);
        assert_eq!(same, vec![0.25, 0.75]);
    }

    #[test]
    fn i16_round_trip() {
        assert_eq!(to_i16(1.0), i16::MAX);
        assert_eq!(to_i16(2.0), i16::MAX);
        assert_eq!(to_i16(-1.0), -i16::MAX);
        assert!((from_i16(to_i16(0.5)) - 0.5).abs() < 1e-4);
    }

    #[test]
    fn the_same_rate_passes_through() {
        let mut r = Resampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn rates_convert_with_the_right_number_of_samples() {
        for (from, to) in [(44_100, 48_000), (48_000, 44_100), (16_000, 48_000), (96_000, 48_000)] {
            let mut r = Resampler::new(from, to);
            let mut out = Vec::new();
            // One second in blocks of 10 ms.
            let block = vec![0.0f32; (from / 100) as usize];
            for _ in 0..100 {
                r.process(&block, &mut out);
            }
            let expected = to as i64;
            // Up to one input sample's worth of output waits for the next block.
            assert!((out.len() as i64 - expected).abs() <= 3, "{from}→{to}: {}", out.len());
        }
    }

    #[test]
    fn interpolation_is_continuous_across_blocks() {
        // A ramp upsampled 1:2 stays a ramp.
        let mut r = Resampler::new(24_000, 48_000);
        let mut out = Vec::new();
        r.process(&[1.0, 2.0], &mut out);
        r.process(&[3.0, 4.0], &mut out);
        assert_eq!(out, vec![1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]);
    }
}
