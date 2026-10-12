// SPDX-License-Identifier: Apache-2.0
//! The system-wide key listener behind the global hotkeys of both desktop shells (docs/DESKTOP.md "Hotkeys"): the Tauri
//! shell's `hotkeys.rs` and the Electron shell's native module (`apps/desktop-electron/native/keywatch`). It
//! **observes** key presses and releases while any program has the focus and **never grabs** them: the other program
//! (a game) still gets every key, so a plain key or a lone modifier can be push-to-talk. It reports nothing but the
//! press and release of the keys in its [`KeyFilter`] (the keys of the current bindings); every other key is dropped
//! where the platform hands it over, nothing is stored or logged.
//!
//! | Platform | How |
//! |---|---|
//! | Windows | a low-level keyboard hook (`SetWindowsHookExW(WH_KEYBOARD_LL)`) on a thread of its own, which passes every key on at once (`CallNextHookEx`); the scan code tells the physical key |
//! | Linux (X11, and X11 programs under XWayland) | the X RECORD extension on two connections of its own (x11rb, pure Rust); the keycode tells the physical key |
//! | others | not available: the keys work while the window has focus |
//!
//! The listener runs only while it is needed (the shell's hotkeys: bindings exist and the client is signed in) and
//! stops with [`Watcher`]'s drop.
//!
//! [`games`] answers the other question the shells ask the system: which game of the user's list runs in front (game
//! activity, opt-in; process names only, never a window title).

pub mod games;
pub mod keys;

#[cfg(target_os = "linux")]
mod x11;

#[cfg(windows)]
mod windows;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;

pub use keys::Key;

/// The keys whose presses and releases the listener reports (a 256-bit set, read lock-free by the platform callback).
#[derive(Debug, Default)]
pub struct KeyFilter {
    bits: [AtomicU64; 4],
}

impl KeyFilter {
    /// Replaces the set.
    pub fn set(&self, keys: impl IntoIterator<Item = Key>) {
        let mut next = [0u64; 4];
        for key in keys {
            let i = key.index();
            if let Some(word) = next.get_mut(i / 64) {
                *word |= 1 << (i % 64);
            }
        }
        for (word, bits) in self.bits.iter().zip(next) {
            word.store(bits, Ordering::Relaxed);
        }
    }

    pub fn contains(&self, key: Key) -> bool {
        let i = key.index();
        self.bits.get(i / 64).is_some_and(|w| w.load(Ordering::Relaxed) & (1 << (i % 64)) != 0)
    }

    pub fn is_empty(&self) -> bool {
        self.bits.iter().all(|w| w.load(Ordering::Relaxed) == 0)
    }
}

/// A press or release of a key in the filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawKey {
    pub key: Key,
    pub pressed: bool,
}

/// Why the listener cannot run here (no X display, no RECORD extension, the hook was refused, another platform).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable(pub String);

/// A running listener; dropping it stops the listener and waits for its thread.
pub trait Watcher: Send {}

/// Starts the platform's listener: presses and releases of the keys in `filter` go to `sink`.
pub fn start(filter: std::sync::Arc<KeyFilter>, sink: Sender<RawKey>) -> Result<Box<dyn Watcher>, Unavailable> {
    #[cfg(target_os = "linux")]
    return x11::start(filter, sink);
    #[cfg(windows)]
    return windows::start(filter, sink);
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = (filter, sink);
        Err(Unavailable("no key listener on this platform".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filter_holds_exactly_the_keys_it_was_given() {
        let filter = KeyFilter::default();
        assert!(filter.is_empty());
        let keys: Vec<Key> = ["ControlLeft", "KeyV", "F24", "MediaStop"].iter().filter_map(|c| Key::from_code(c)).collect();
        assert_eq!(keys.len(), 4);
        filter.set(keys.iter().copied());
        for key in &keys {
            assert!(filter.contains(*key), "{}", key.code());
        }
        for other in ["ControlRight", "KeyB", "F23"] {
            assert!(Key::from_code(other).is_some_and(|k| !filter.contains(k)), "{other}");
        }
        filter.set([]);
        assert!(filter.is_empty());
        assert!(!keys.iter().any(|k| filter.contains(*k)));
    }
}
