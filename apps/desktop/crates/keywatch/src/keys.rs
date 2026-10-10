// SPDX-License-Identifier: Apache-2.0
//! The keys the listener knows: `KeyboardEvent.code` names (what the client's recorder stores) with the physical key
//! numbers of the platforms: the Linux evdev code (an X11 keycode is the evdev code + 8) and the Windows scan code
//! (set 1, `0xE0..` for the extended keys). Both are layout independent, like `KeyboardEvent.code`; the numbers follow
//! the W3C "UI Events KeyboardEvent code Values" mapping tables (and Chromium's `dom_code_data.inc`).

/// A known key: its index in [`KEYS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Key(pub(crate) u8);

/// `(KeyboardEvent.code, evdev code, Windows scan code)`.
pub(crate) const KEYS: &[(&str, u16, u16)] = &[
    ("Escape", 1, 0x01),
    ("Digit1", 2, 0x02),
    ("Digit2", 3, 0x03),
    ("Digit3", 4, 0x04),
    ("Digit4", 5, 0x05),
    ("Digit5", 6, 0x06),
    ("Digit6", 7, 0x07),
    ("Digit7", 8, 0x08),
    ("Digit8", 9, 0x09),
    ("Digit9", 10, 0x0a),
    ("Digit0", 11, 0x0b),
    ("Minus", 12, 0x0c),
    ("Equal", 13, 0x0d),
    ("Backspace", 14, 0x0e),
    ("Tab", 15, 0x0f),
    ("KeyQ", 16, 0x10),
    ("KeyW", 17, 0x11),
    ("KeyE", 18, 0x12),
    ("KeyR", 19, 0x13),
    ("KeyT", 20, 0x14),
    ("KeyY", 21, 0x15),
    ("KeyU", 22, 0x16),
    ("KeyI", 23, 0x17),
    ("KeyO", 24, 0x18),
    ("KeyP", 25, 0x19),
    ("BracketLeft", 26, 0x1a),
    ("BracketRight", 27, 0x1b),
    ("Enter", 28, 0x1c),
    ("ControlLeft", 29, 0x1d),
    ("KeyA", 30, 0x1e),
    ("KeyS", 31, 0x1f),
    ("KeyD", 32, 0x20),
    ("KeyF", 33, 0x21),
    ("KeyG", 34, 0x22),
    ("KeyH", 35, 0x23),
    ("KeyJ", 36, 0x24),
    ("KeyK", 37, 0x25),
    ("KeyL", 38, 0x26),
    ("Semicolon", 39, 0x27),
    ("Quote", 40, 0x28),
    ("Backquote", 41, 0x29),
    ("ShiftLeft", 42, 0x2a),
    ("Backslash", 43, 0x2b),
    ("KeyZ", 44, 0x2c),
    ("KeyX", 45, 0x2d),
    ("KeyC", 46, 0x2e),
    ("KeyV", 47, 0x2f),
    ("KeyB", 48, 0x30),
    ("KeyN", 49, 0x31),
    ("KeyM", 50, 0x32),
    ("Comma", 51, 0x33),
    ("Period", 52, 0x34),
    ("Slash", 53, 0x35),
    ("ShiftRight", 54, 0x36),
    ("NumpadMultiply", 55, 0x37),
    ("AltLeft", 56, 0x38),
    ("Space", 57, 0x39),
    ("CapsLock", 58, 0x3a),
    ("F1", 59, 0x3b),
    ("F2", 60, 0x3c),
    ("F3", 61, 0x3d),
    ("F4", 62, 0x3e),
    ("F5", 63, 0x3f),
    ("F6", 64, 0x40),
    ("F7", 65, 0x41),
    ("F8", 66, 0x42),
    ("F9", 67, 0x43),
    ("F10", 68, 0x44),
    ("NumLock", 69, 0xe045),
    ("ScrollLock", 70, 0x46),
    ("Numpad7", 71, 0x47),
    ("Numpad8", 72, 0x48),
    ("Numpad9", 73, 0x49),
    ("NumpadSubtract", 74, 0x4a),
    ("Numpad4", 75, 0x4b),
    ("Numpad5", 76, 0x4c),
    ("Numpad6", 77, 0x4d),
    ("NumpadAdd", 78, 0x4e),
    ("Numpad1", 79, 0x4f),
    ("Numpad2", 80, 0x50),
    ("Numpad3", 81, 0x51),
    ("Numpad0", 82, 0x52),
    ("NumpadDecimal", 83, 0x53),
    ("IntlBackslash", 86, 0x56),
    ("F11", 87, 0x57),
    ("F12", 88, 0x58),
    ("NumpadEnter", 96, 0xe01c),
    ("ControlRight", 97, 0xe01d),
    ("NumpadDivide", 98, 0xe035),
    ("PrintScreen", 99, 0xe037),
    ("AltRight", 100, 0xe038),
    ("Home", 102, 0xe047),
    ("ArrowUp", 103, 0xe048),
    ("PageUp", 104, 0xe049),
    ("ArrowLeft", 105, 0xe04b),
    ("ArrowRight", 106, 0xe04d),
    ("End", 107, 0xe04f),
    ("ArrowDown", 108, 0xe050),
    ("PageDown", 109, 0xe051),
    ("Insert", 110, 0xe052),
    ("Delete", 111, 0xe053),
    ("AudioVolumeMute", 113, 0xe020),
    ("AudioVolumeDown", 114, 0xe02e),
    ("AudioVolumeUp", 115, 0xe030),
    ("NumpadEqual", 117, 0x59),
    ("Pause", 119, 0x45),
    ("MetaLeft", 125, 0xe05b),
    ("MetaRight", 126, 0xe05c),
    ("ContextMenu", 127, 0xe05d),
    ("MediaTrackNext", 163, 0xe019),
    ("MediaPlayPause", 164, 0xe022),
    ("MediaTrackPrevious", 165, 0xe010),
    ("MediaStop", 166, 0xe024),
    ("F13", 183, 0x64),
    ("F14", 184, 0x65),
    ("F15", 185, 0x66),
    ("F16", 186, 0x67),
    ("F17", 187, 0x68),
    ("F18", 188, 0x69),
    ("F19", 189, 0x6a),
    ("F20", 190, 0x6b),
    ("F21", 191, 0x6c),
    ("F22", 192, 0x6d),
    ("F23", 193, 0x6e),
    ("F24", 194, 0x76),
];

impl Key {
    /// The key of a `KeyboardEvent.code` (exact spelling).
    pub fn from_code(code: &str) -> Option<Key> {
        KEYS.iter().position(|(c, _, _)| *c == code).map(|i| Key(i as u8))
    }

    /// The key of an X11 keycode (evdev code + 8).
    pub fn from_x11(keycode: u8) -> Option<Key> {
        let evdev = u16::from(keycode).checked_sub(8)?;
        KEYS.iter().position(|(_, e, _)| *e == evdev).map(|i| Key(i as u8))
    }

    /// The key of a Windows scan code (`0xE0..` for extended keys).
    pub fn from_scan_code(scan: u16) -> Option<Key> {
        KEYS.iter().position(|(_, _, w)| *w == scan).map(|i| Key(i as u8))
    }

    /// Its `KeyboardEvent.code`.
    pub fn code(self) -> &'static str {
        KEYS.get(usize::from(self.0)).map_or("", |k| k.0)
    }

    pub(crate) fn index(self) -> usize {
        usize::from(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn codes_and_numbers_are_unique() {
        assert!(KEYS.len() <= 256, "a key is a u8 index (and the filter has 256 bits)");
        let codes: HashSet<_> = KEYS.iter().map(|k| k.0).collect();
        let evdev: HashSet<_> = KEYS.iter().map(|k| k.1).collect();
        let windows: HashSet<_> = KEYS.iter().map(|k| k.2).collect();
        assert_eq!(codes.len(), KEYS.len());
        assert_eq!(evdev.len(), KEYS.len());
        assert_eq!(windows.len(), KEYS.len());
    }

    #[test]
    fn maps_the_platform_numbers_to_keyboard_event_codes() {
        let code = |k: Option<Key>| k.map(Key::code);
        // X11 keycodes as `xev` shows them on a PC keyboard.
        assert_eq!(code(Key::from_x11(37)), Some("ControlLeft"));
        assert_eq!(code(Key::from_x11(105)), Some("ControlRight"));
        assert_eq!(code(Key::from_x11(50)), Some("ShiftLeft"));
        assert_eq!(code(Key::from_x11(62)), Some("ShiftRight"));
        assert_eq!(code(Key::from_x11(64)), Some("AltLeft"));
        assert_eq!(code(Key::from_x11(108)), Some("AltRight"));
        assert_eq!(code(Key::from_x11(133)), Some("MetaLeft"));
        assert_eq!(code(Key::from_x11(55)), Some("KeyV"));
        assert_eq!(code(Key::from_x11(58)), Some("KeyM"));
        assert_eq!(code(Key::from_x11(49)), Some("Backquote"));
        assert_eq!(code(Key::from_x11(65)), Some("Space"));
        assert_eq!(code(Key::from_x11(191)), Some("F13"));
        assert_eq!(code(Key::from_x11(127)), Some("Pause"));
        assert_eq!(Key::from_x11(7), None);
        assert_eq!(Key::from_x11(255), None);
        // Windows scan codes of the low-level keyboard hook (extended keys with 0xE0).
        assert_eq!(code(Key::from_scan_code(0x1d)), Some("ControlLeft"));
        assert_eq!(code(Key::from_scan_code(0xe01d)), Some("ControlRight"));
        assert_eq!(code(Key::from_scan_code(0x2f)), Some("KeyV"));
        assert_eq!(code(Key::from_scan_code(0xe05b)), Some("MetaLeft"));
        assert_eq!(code(Key::from_scan_code(0x45)), Some("Pause"));
        assert_eq!(code(Key::from_scan_code(0xe045)), Some("NumLock"));
        assert_eq!(code(Key::from_scan_code(0x76)), Some("F24"));
        assert_eq!(Key::from_scan_code(0x21d), None, "the fake Ctrl of AltGr is not a key");
        assert_eq!(code(Key::from_code("NumpadEnter")), Some("NumpadEnter"));
        assert_eq!(Key::from_code("keyv"), None);
    }

    #[test]
    fn the_main_block_has_the_same_numbers_on_both_platforms() {
        // evdev codes 1–88 are the set-1 scan codes (the reason the table is easy to check).
        for (code, evdev, windows) in KEYS.iter().filter(|k| k.1 <= 88 && k.0 != "NumLock") {
            assert_eq!(evdev, windows, "{code}");
        }
    }
}
