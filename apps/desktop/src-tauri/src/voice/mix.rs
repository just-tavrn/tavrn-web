// SPDX-License-Identifier: Apache-2.0
//! Playback mix of the native engine: one buffer per subscribed remote audio track (decoded, decrypted, 48 kHz
//! mono), a gain per participant (the web client's per-user volume × output volume, 0 while deafened: `volume.ts`
//! decides, the engine applies) and the speaking level of each participant (the loudest 10 ms RMS since the last
//! report, which the webview's speaking detector turns into rings exactly like its analysers). Pure, no audio I/O.

use std::collections::{HashMap, VecDeque};

use super::dsp::FRAME;
use super::gate::dbfs;

/// A track buffer never holds more than this (200 ms): older audio is dropped when the device clock runs slower than
/// the sender's, so the delay stays bounded.
const MAX_BUFFERED: usize = FRAME * 20;
/// Playback of a track starts once this much (40 ms) is buffered, which absorbs the jitter of frame delivery.
const START_BUFFERED: usize = FRAME * 4;
/// Gains are capped (the web client's volumes go up to 200 % × 200 %).
pub const MAX_GAIN: f32 = 4.0;

#[derive(Debug)]
struct Source {
    identity: String,
    buf: VecDeque<f32>,
    playing: bool,
}

#[derive(Debug, Default)]
pub struct Mixer {
    sources: HashMap<String, Source>,
    gains: HashMap<String, f32>,
    /// Loudest RMS (dBFS) per identity since the last `take_levels`.
    levels: HashMap<String, f64>,
    /// The last report was all silence (`take_report` stays quiet until someone is audible again).
    quiet: bool,
    deafened: bool,
}

impl Mixer {
    /// A remote audio track was subscribed (`key`: its track sid).
    pub fn add(&mut self, key: &str, identity: &str) {
        self.sources.insert(key.to_string(), Source { identity: identity.to_string(), buf: VecDeque::new(), playing: false });
    }

    pub fn remove(&mut self, key: &str) {
        if let Some(s) = self.sources.remove(key)
            && !self.sources.values().any(|o| o.identity == s.identity)
        {
            self.levels.remove(&s.identity);
        }
    }

    pub fn clear(&mut self) {
        self.sources.clear();
        self.levels.clear();
    }

    /// Decoded audio of a track (48 kHz mono); also measures the participant's level.
    pub fn push(&mut self, key: &str, samples: &[f32]) {
        let Some(source) = self.sources.get_mut(key) else { return };
        let level = dbfs(samples);
        // Called for every 10 ms frame of every track: the identity is cloned only for its first frame.
        match self.levels.get_mut(&source.identity) {
            Some(entry) if level > *entry => *entry = level,
            Some(_) => {}
            None => {
                self.levels.insert(source.identity.clone(), level);
            }
        }
        source.buf.extend(samples);
        if source.buf.len() > MAX_BUFFERED {
            let excess = source.buf.len() - MAX_BUFFERED;
            source.buf.drain(..excess);
        }
    }

    /// Discard buffered playback and speaking levels until this participant authenticates again.
    pub fn quarantine(&mut self, identity: &str) {
        for source in self.sources.values_mut().filter(|source| source.identity == identity) {
            source.buf.clear();
            source.playing = false;
        }
        self.levels.remove(identity);
    }

    /// The gain of one participant (identity `<address>/<device>`), clamped to 0…`MAX_GAIN`.
    pub fn set_gain(&mut self, identity: &str, gain: f32) {
        let gain = if gain.is_finite() { gain.clamp(0.0, MAX_GAIN) } else { 1.0 };
        self.gains.insert(identity.to_string(), gain);
    }

    pub fn gain(&self, identity: &str) -> f32 {
        self.gains.get(identity).copied().unwrap_or(1.0)
    }

    /// Deafened: nothing plays (whatever the gains say).
    pub fn set_deafened(&mut self, deafened: bool) {
        self.deafened = deafened;
    }

    /// Mixes the next `out.len()` samples of every track into `out` (overwritten).
    pub fn mix(&mut self, out: &mut [f32]) {
        out.fill(0.0);
        for source in self.sources.values_mut() {
            if !source.playing {
                if source.buf.len() < START_BUFFERED {
                    continue;
                }
                source.playing = true;
            }
            let gain = if self.deafened { 0.0 } else { self.gains.get(&source.identity).copied().unwrap_or(1.0) };
            let n = out.len().min(source.buf.len());
            for (o, s) in out.iter_mut().zip(source.buf.drain(..n)) {
                *o += s * gain;
            }
            // Ran dry: wait for the start buffer again (no crackle of single frames).
            if source.buf.is_empty() {
                source.playing = false;
            }
        }
        for o in out.iter_mut() {
            *o = o.clamp(-1.0, 1.0);
        }
    }

    /// The loudest level per participant since the last call (dBFS; `-inf` for silence), then starts over.
    pub fn take_levels(&mut self) -> Vec<(String, f64)> {
        let mut out: Vec<(String, f64)> = self.levels.iter().map(|(k, v)| (k.clone(), *v)).collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        for v in self.levels.values_mut() {
            *v = f64::NEG_INFINITY;
        }
        out
    }

    /// The levels for the webview (`take_levels`), or `None` while nobody was audible since a report that already said
    /// so: in silence nothing goes over IPC (the webview's speaking detector lets the rings fade by itself).
    pub fn take_report(&mut self) -> Option<Vec<(String, f64)>> {
        let levels = self.take_levels();
        let silent = levels.iter().all(|(_, v)| !v.is_finite());
        if levels.is_empty() || (silent && self.quiet) {
            return None;
        }
        self.quiet = silent;
        Some(levels)
    }

    pub fn track_count(&self) -> usize {
        self.sources.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(n: usize, v: f32) -> Vec<f32> {
        vec![v; FRAME * n]
    }

    #[test]
    fn quarantine_discards_buffered_audio_and_levels_but_allows_authenticated_recovery() {
        let mut mixer = Mixer::default();
        mixer.add("mic", "alice");
        mixer.push("mic", &frames(8, 0.25));
        mixer.quarantine("alice");
        let mut out = vec![0.0; FRAME];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 0.0));
        assert!(mixer.take_levels().is_empty());
        mixer.push("mic", &frames(8, 0.25));
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 0.25));
        assert!(mixer.take_levels().iter().any(|(identity, _)| identity == "alice"));
    }

    #[test]
    fn tracks_mix_with_their_participant_gain() {
        let mut m = Mixer::default();
        m.add("TR_a", "alice@a.example/1");
        m.add("TR_b", "bob@b.example/1");
        m.push("TR_a", &frames(4, 0.1));
        m.push("TR_b", &frames(4, 0.2));
        m.set_gain("bob@b.example/1", 0.5);
        let mut out = vec![1.0; FRAME];
        m.mix(&mut out);
        assert!(out.iter().all(|s| (s - 0.2).abs() < 1e-6), "{}", out[0]);
    }

    #[test]
    fn playback_waits_for_the_start_buffer_and_drops_old_audio() {
        let mut m = Mixer::default();
        m.add("TR_a", "alice/1");
        m.push("TR_a", &frames(1, 0.5));
        let mut out = vec![0.0; FRAME];
        m.mix(&mut out);
        assert!(out.iter().all(|s| *s == 0.0), "one frame is not enough to start");
        m.push("TR_a", &frames(40, 0.5));
        m.mix(&mut out);
        assert!(out.iter().all(|s| *s == 0.5));
        // At most 200 ms stay buffered: 20 frames, one of them played.
        let mut rest = 0;
        loop {
            m.mix(&mut out);
            if out[0] == 0.0 {
                break;
            }
            rest += 1;
        }
        assert_eq!(rest, 19);
    }

    #[test]
    fn deafened_nothing_plays_and_gains_are_clamped() {
        let mut m = Mixer::default();
        m.add("TR_a", "alice/1");
        m.set_gain("alice/1", 9.0);
        assert_eq!(m.gain("alice/1"), MAX_GAIN);
        m.set_gain("alice/1", f32::NAN);
        assert_eq!(m.gain("alice/1"), 1.0);
        m.set_deafened(true);
        m.push("TR_a", &frames(5, 0.5));
        let mut out = vec![0.0; FRAME];
        m.mix(&mut out);
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn the_sum_is_clipped() {
        let mut m = Mixer::default();
        for k in ["a", "b", "c"] {
            m.add(k, k);
            m.push(k, &frames(5, 0.6));
        }
        let mut out = vec![0.0; FRAME];
        m.mix(&mut out);
        assert!(out.iter().all(|s| *s == 1.0));
    }

    #[test]
    fn levels_are_the_loudest_since_the_last_report() {
        let mut m = Mixer::default();
        m.add("TR_a", "alice/1");
        m.add("TR_b", "bob/1");
        m.push("TR_a", &frames(1, 0.1));
        m.push("TR_a", &frames(1, 0.01));
        m.push("TR_b", &frames(1, 0.0));
        let levels = m.take_levels();
        assert_eq!(levels.len(), 2);
        assert!((levels[0].1 + 20.0).abs() < 1e-6, "{levels:?}");
        assert_eq!(levels[1].1, f64::NEG_INFINITY);
        assert!(m.take_levels().iter().all(|(_, v)| *v == f64::NEG_INFINITY));
        m.remove("TR_a");
        assert_eq!(m.take_levels().len(), 1);
        assert_eq!(m.track_count(), 1);
    }

    #[test]
    fn reports_go_out_while_someone_is_audible_and_once_when_all_fell_silent() {
        let mut m = Mixer::default();
        assert!(m.take_report().is_none(), "nobody in the mix");
        m.add("TR_a", "alice/1");
        m.push("TR_a", &frames(1, 0.0));
        // Silence from the start: the first report says so, then nothing until someone is audible.
        assert!(m.take_report().is_some());
        let silent_ticks = (0..20).filter(|_| m.take_report().is_some()).count();
        assert_eq!(silent_ticks, 0, "20 silent ticks (1 s) send nothing");
        m.push("TR_a", &frames(1, 0.1));
        assert!(m.take_report().is_some_and(|l| l[0].1.is_finite()), "audible");
        // Silent again: one report with -inf, then quiet.
        assert!(m.take_report().is_some_and(|l| l.iter().all(|(_, v)| *v == f64::NEG_INFINITY)));
        assert!(m.take_report().is_none());
    }
}
