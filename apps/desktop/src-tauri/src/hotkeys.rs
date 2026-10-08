// SPDX-License-Identifier: Apache-2.0
//! Global hotkeys of the voice client (docs/DESKTOP.md "Global hotkeys"): push-to-talk, priority speaker, toggle mute
//! and toggle deafen work while the app is in the background. The client keeps the bindings in its voice settings
//! and registers them here at start and whenever they change; the shell validates the combination, refuses one that
//! another action already uses, grabs it through the OS (tauri-plugin-global-shortcut) and reports presses and
//! releases to the client over the channel of `listen_hotkeys`.
//!
//! A combination is written as the client captures it: modifiers in a fixed order and one key as
//! `KeyboardEvent.code` names it, e.g. `Ctrl+Shift+KeyM`, `F13`, `Alt+Numpad1`. `Super` is the Windows key on
//! Windows, Cmd on macOS and Super/Meta on Linux; `Cmd`, `Win`, `Meta`, `Command`, `Control` and `Option` are accepted
//! as spellings. A global grab takes the key away from every other program, so a key that types text (letters,
//! digits, punctuation, Space, Enter, Tab, arrows, Delete) needs Ctrl, Alt or Super; function keys, the numpad and the
//! navigation block (Insert, Home, End, Page Up/Down, Pause, Scroll Lock, Print Screen) may stand alone.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState};

/// What a binding does in the voice client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Held: the microphone transmits.
    PushToTalk,
    /// Held: priority speaker.
    Priority,
    ToggleMute,
    ToggleDeafen,
}

/// Why a combination is refused; `code()` is what the client translates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyError {
    /// Not a combination the shell understands (unknown key, a modifier alone, two keys, empty).
    Invalid,
    /// A key that types text without Ctrl, Alt or Super: grabbing it would break typing everywhere.
    TypingKey,
    /// Another action uses this combination.
    Duplicate(Action),
    /// The OS refused the grab (another program holds it, or no X11 display on Linux).
    Unavailable,
}

impl HotkeyError {
    pub fn code(&self) -> &'static str {
        match self {
            HotkeyError::Invalid => "hotkey.invalid",
            HotkeyError::TypingKey => "hotkey.typing_key",
            HotkeyError::Duplicate(_) => "hotkey.duplicate",
            HotkeyError::Unavailable => "hotkey.unavailable",
        }
    }
}

/// A validated combination: modifiers and one key (`KeyboardEvent.code`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows key, Cmd on macOS, Super/Meta on Linux.
    pub super_key: bool,
    pub key: &'static str,
}

/// Keys that may stand alone (they type no text).
const FREE_KEYS: &[&str] = &[
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
    "F13",
    "F14",
    "F15",
    "F16",
    "F17",
    "F18",
    "F19",
    "F20",
    "F21",
    "F22",
    "F23",
    "F24",
    "Numpad0",
    "Numpad1",
    "Numpad2",
    "Numpad3",
    "Numpad4",
    "Numpad5",
    "Numpad6",
    "Numpad7",
    "Numpad8",
    "Numpad9",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
    "NumpadEnter",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Pause",
    "ScrollLock",
    "PrintScreen",
];

/// Keys that type text: only with Ctrl, Alt or Super. Escape and Backspace are missing on purpose: the recorder of
/// the client uses them (cancel, clear).
const TYPING_KEYS: &[&str] = &[
    "KeyA",
    "KeyB",
    "KeyC",
    "KeyD",
    "KeyE",
    "KeyF",
    "KeyG",
    "KeyH",
    "KeyI",
    "KeyJ",
    "KeyK",
    "KeyL",
    "KeyM",
    "KeyN",
    "KeyO",
    "KeyP",
    "KeyQ",
    "KeyR",
    "KeyS",
    "KeyT",
    "KeyU",
    "KeyV",
    "KeyW",
    "KeyX",
    "KeyY",
    "KeyZ",
    "Digit0",
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Backquote",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "Space",
    "Enter",
    "Tab",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
];

/// The longest combination text the shell looks at.
const MAX_LEN: usize = 64;

impl Combo {
    /// Parses and validates a combination (see the module documentation).
    pub fn parse(text: &str) -> Result<Self, HotkeyError> {
        if text.is_empty() || text.len() > MAX_LEN {
            return Err(HotkeyError::Invalid);
        }
        let mut combo = Combo { ctrl: false, alt: false, shift: false, super_key: false, key: "" };
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let (key, modifiers) = parts.split_last().ok_or(HotkeyError::Invalid)?;
        for m in modifiers {
            let flag = match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => &mut combo.ctrl,
                "alt" | "option" => &mut combo.alt,
                "shift" => &mut combo.shift,
                "super" | "meta" | "cmd" | "command" | "win" => &mut combo.super_key,
                _ => return Err(HotkeyError::Invalid),
            };
            if *flag {
                return Err(HotkeyError::Invalid);
            }
            *flag = true;
        }
        let free = FREE_KEYS.iter().find(|k| **k == *key);
        let typing = TYPING_KEYS.iter().find(|k| **k == *key);
        combo.key = free.or(typing).copied().ok_or(HotkeyError::Invalid)?;
        if typing.is_some() && !(combo.ctrl || combo.alt || combo.super_key) {
            return Err(HotkeyError::TypingKey);
        }
        Ok(combo)
    }

    /// The OS-level shortcut (`Super` is the Windows key, Cmd or Super through the plugin).
    pub fn shortcut(&self) -> Result<Shortcut, HotkeyError> {
        let code = Code::from_str(self.key).map_err(|_| HotkeyError::Invalid)?;
        let mut mods = Modifiers::empty();
        mods.set(Modifiers::CONTROL, self.ctrl);
        mods.set(Modifiers::ALT, self.alt);
        mods.set(Modifiers::SHIFT, self.shift);
        mods.set(Modifiers::SUPER, self.super_key);
        Ok(Shortcut::new(Some(mods), code))
    }
}

/// The canonical spelling: `Ctrl+Alt+Shift+Super+<code>`, what the client stores.
impl fmt::Display for Combo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (on, name) in [(self.ctrl, "Ctrl+"), (self.alt, "Alt+"), (self.shift, "Shift+"), (self.super_key, "Super+")] {
            if on {
                f.write_str(name)?;
            }
        }
        f.write_str(self.key)
    }
}

/// The OS side of a binding: grabbing and releasing a combination (the plugin in the app, a fake in the tests).
pub trait Grabber {
    fn grab(&self, combo: &Combo) -> Result<(), HotkeyError>;
    fn release(&self, combo: &Combo);
}

/// The bindings the shell holds: at most one combination per action, never one combination for two actions.
#[derive(Debug, Default)]
pub struct Registry {
    bindings: BTreeMap<Action, Combo>,
}

impl Registry {
    /// Binds `text` to `action`: validates, refuses duplicates, grabs the new combination before it releases the old
    /// one (a refused grab keeps the old binding). Returns the canonical spelling.
    pub fn bind(&mut self, action: Action, text: &str, os: &dyn Grabber) -> Result<String, HotkeyError> {
        let combo = Combo::parse(text)?;
        if let Some((other, _)) = self.bindings.iter().find(|(a, c)| **a != action && **c == combo) {
            return Err(HotkeyError::Duplicate(*other));
        }
        if self.bindings.get(&action) == Some(&combo) {
            return Ok(combo.to_string());
        }
        os.grab(&combo)?;
        if let Some(old) = self.bindings.insert(action, combo.clone()) {
            os.release(&old);
        }
        Ok(combo.to_string())
    }

    /// Removes the binding of `action` (nothing bound: nothing happens).
    pub fn unbind(&mut self, action: Action, os: &dyn Grabber) {
        if let Some(old) = self.bindings.remove(&action) {
            os.release(&old);
        }
    }

    /// The OS shortcut ids of the bound actions.
    pub fn ids(&self) -> Vec<(u32, Action)> {
        self.bindings.iter().filter_map(|(a, c)| c.shortcut().ok().map(|s| (s.id(), *a))).collect()
    }

    pub fn get(&self, action: Action) -> Option<&Combo> {
        self.bindings.get(&action)
    }
}

/// A press or release reported to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HotkeyEvent {
    pub action: Action,
    pub pressed: bool,
}

/// The registry, a copy of its shortcut ids for the event thread and the client's event channel (the newest
/// `listen_hotkeys` call; a reloaded page replaces it). Events never take the registry's lock: it is held while the
/// plugin grabs a combination, and the plugin holds its own lock while it calls the event handler.
#[derive(Default)]
pub struct Hotkeys {
    registry: Mutex<Registry>,
    ids: Mutex<Vec<(u32, Action)>>,
    channel: Mutex<Option<Channel<HotkeyEvent>>>,
}

impl Hotkeys {
    /// [`Registry::bind`]
    pub fn bind(&self, action: Action, text: &str, os: &dyn Grabber) -> Result<String, HotkeyError> {
        let mut registry = self.registry.lock().map_err(|_| HotkeyError::Unavailable)?;
        let result = registry.bind(action, text, os);
        self.refresh(&registry);
        result
    }

    /// [`Registry::unbind`]
    pub fn unbind(&self, action: Action, os: &dyn Grabber) -> Result<(), HotkeyError> {
        let mut registry = self.registry.lock().map_err(|_| HotkeyError::Unavailable)?;
        registry.unbind(action, os);
        self.refresh(&registry);
        Ok(())
    }

    fn refresh(&self, registry: &Registry) {
        if let Ok(mut ids) = self.ids.lock() {
            *ids = registry.ids();
        }
    }

    /// The event of an OS shortcut, if it is bound.
    pub fn event_of(&self, shortcut: &Shortcut, state: ShortcutState) -> Option<HotkeyEvent> {
        let action = self.ids.lock().ok()?.iter().find(|(id, _)| *id == shortcut.id())?.1;
        Some(HotkeyEvent { action, pressed: state == ShortcutState::Pressed })
    }

    /// Hands a shortcut event of the plugin to the client.
    pub fn dispatch(&self, shortcut: &Shortcut, event: ShortcutEvent) {
        let Some(e) = self.event_of(shortcut, event.state) else { return };
        if let Ok(channel) = self.channel.lock()
            && let Some(channel) = channel.as_ref()
        {
            let _ = channel.send(e);
        }
    }
}

/// The plugin as the grabber of the app.
struct Os<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> Grabber for Os<'_, R> {
    fn grab(&self, combo: &Combo) -> Result<(), HotkeyError> {
        self.0.global_shortcut().register(combo.shortcut()?).map_err(|e| {
            eprintln!("tavrn: hotkey {combo} not registered: {e}");
            HotkeyError::Unavailable
        })
    }

    fn release(&self, combo: &Combo) {
        if let Ok(s) = combo.shortcut() {
            let _ = self.0.global_shortcut().unregister(s);
        }
    }
}

/// Binds a combination to an action; returns its canonical spelling or an error code (`hotkey.*`). Async: the
/// plugin grabs on the main thread and waits for it, so the command must not run there.
#[tauri::command]
pub async fn register_hotkey<R: Runtime>(app: AppHandle<R>, hotkeys: State<'_, Hotkeys>, action: Action, combo: String) -> Result<String, String> {
    hotkeys.bind(action, &combo, &Os(&app)).map_err(|e| e.code().to_string())
}

/// Removes the binding of an action.
#[tauri::command]
pub async fn unregister_hotkey<R: Runtime>(app: AppHandle<R>, hotkeys: State<'_, Hotkeys>, action: Action) -> Result<(), String> {
    hotkeys.unbind(action, &Os(&app)).map_err(|e| e.code().to_string())
}

/// The client's channel for presses and releases.
#[tauri::command]
pub fn listen_hotkeys(hotkeys: State<'_, Hotkeys>, on_event: Channel<HotkeyEvent>) -> Result<(), String> {
    *hotkeys.channel.lock().map_err(|_| "hotkey.unavailable".to_string())? = Some(on_event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeOs {
        grabbed: RefCell<Vec<String>>,
        refuse: Option<&'static str>,
    }

    impl Grabber for FakeOs {
        fn grab(&self, combo: &Combo) -> Result<(), HotkeyError> {
            if self.refuse == Some(combo.key) {
                return Err(HotkeyError::Unavailable);
            }
            self.grabbed.borrow_mut().push(combo.to_string());
            Ok(())
        }
        fn release(&self, combo: &Combo) {
            self.grabbed.borrow_mut().retain(|c| *c != combo.to_string());
        }
    }

    fn canonical(text: &str) -> Result<String, HotkeyError> {
        Combo::parse(text).map(|c| c.to_string())
    }

    #[test]
    fn parses_and_formats_combinations_in_a_fixed_order() {
        assert_eq!(canonical("Ctrl+Shift+KeyM"), Ok("Ctrl+Shift+KeyM".into()));
        assert_eq!(canonical("shift+control+KeyM"), Ok("Ctrl+Shift+KeyM".into()));
        assert_eq!(canonical("Super+Alt+Shift+Ctrl+Digit1"), Ok("Ctrl+Alt+Shift+Super+Digit1".into()));
        assert_eq!(canonical("F13"), Ok("F13".into()));
        assert_eq!(canonical("Alt + Numpad1"), Ok("Alt+Numpad1".into()));
        assert_eq!(canonical("Option+KeyT"), Ok("Alt+KeyT".into()));
    }

    #[test]
    fn super_is_the_windows_key_cmd_and_meta() {
        for spelling in ["Super+KeyM", "Cmd+KeyM", "Command+KeyM", "Win+KeyM", "Meta+KeyM", "SUPER+KeyM"] {
            let combo = Combo::parse(spelling).unwrap_or_else(|e| unreachable!("{spelling}: {e:?}"));
            assert_eq!(combo.to_string(), "Super+KeyM", "{spelling}");
            let shortcut = combo.shortcut().unwrap_or_else(|e| unreachable!("{e:?}"));
            assert_eq!(shortcut.mods, Modifiers::SUPER, "the plugin's Super: Windows key, Cmd, Super");
            assert_eq!(shortcut.key, Code::KeyM);
        }
        let all = Combo::parse("Ctrl+Alt+Shift+Super+F1").and_then(|c| c.shortcut()).unwrap_or_else(|e| unreachable!("{e:?}"));
        assert_eq!(all.mods, Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER);
    }

    #[test]
    fn refuses_invalid_combinations() {
        for bad in [
            "",
            "+",
            "Ctrl+",
            "Ctrl",
            "Ctrl+Shift",
            "KeyQ+KeyM",
            "Ctrl+KeyQ+KeyM",
            "Hyper+KeyM",
            "Ctrl+Ctrl+KeyM",
            "Ctrl+keym",
            "Ctrl+Escape",
            "Ctrl+Backspace",
            "Ctrl+ControlLeft",
            "Ctrl+Unknown",
            "Ctrl+F25",
        ] {
            assert_eq!(Combo::parse(bad), Err(HotkeyError::Invalid), "{bad:?}");
        }
        assert_eq!(Combo::parse(&format!("Ctrl+{}", "K".repeat(70))), Err(HotkeyError::Invalid));
    }

    #[test]
    fn a_typing_key_needs_ctrl_alt_or_super() {
        for typing in ["KeyM", "Shift+KeyM", "Space", "Digit1", "Backquote", "Enter", "Tab", "ArrowUp", "Shift+Delete"] {
            assert_eq!(Combo::parse(typing), Err(HotkeyError::TypingKey), "{typing}");
        }
        for ok in
            ["Ctrl+KeyM", "Alt+Space", "Super+Backquote", "Ctrl+Shift+ArrowUp", "F1", "Shift+F24", "NumpadAdd", "Pause", "ScrollLock", "Insert", "PageDown"]
        {
            assert!(Combo::parse(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn every_known_key_maps_to_an_os_shortcut() {
        for key in FREE_KEYS.iter().chain(TYPING_KEYS) {
            let combo = Combo::parse(&format!("Ctrl+{key}")).unwrap_or_else(|e| unreachable!("{key}: {e:?}"));
            assert!(combo.shortcut().is_ok(), "{key}");
        }
    }

    #[test]
    fn binds_replaces_and_unbinds() {
        let os = FakeOs::default();
        let mut r = Registry::default();
        assert_eq!(r.bind(Action::ToggleMute, "ctrl+shift+KeyM", &os), Ok("Ctrl+Shift+KeyM".into()));
        assert_eq!(r.bind(Action::ToggleMute, "Ctrl+Shift+KeyM", &os), Ok("Ctrl+Shift+KeyM".into()), "the same binding again is a no-op");
        assert_eq!(*os.grabbed.borrow(), ["Ctrl+Shift+KeyM"]);
        assert_eq!(r.bind(Action::ToggleMute, "F14", &os), Ok("F14".into()));
        assert_eq!(*os.grabbed.borrow(), ["F14"], "the old combination is released");
        r.unbind(Action::ToggleMute, &os);
        assert!(os.grabbed.borrow().is_empty());
        assert!(r.get(Action::ToggleMute).is_none());
        r.unbind(Action::ToggleMute, &os);
    }

    #[test]
    fn refuses_a_combination_of_another_action() {
        let os = FakeOs::default();
        let mut r = Registry::default();
        assert!(r.bind(Action::PushToTalk, "F13", &os).is_ok());
        assert_eq!(r.bind(Action::Priority, "F13", &os), Err(HotkeyError::Duplicate(Action::PushToTalk)));
        assert_eq!(r.bind(Action::Priority, "F13", &os).map_err(|e| e.code()), Err("hotkey.duplicate"));
        assert!(r.get(Action::Priority).is_none());
        assert_eq!(*os.grabbed.borrow(), ["F13"]);
    }

    #[test]
    fn a_refused_grab_keeps_the_old_binding() {
        let os = FakeOs { refuse: Some("F15"), ..FakeOs::default() };
        let mut r = Registry::default();
        assert!(r.bind(Action::ToggleDeafen, "F16", &os).is_ok());
        assert_eq!(r.bind(Action::ToggleDeafen, "F15", &os), Err(HotkeyError::Unavailable));
        assert_eq!(r.get(Action::ToggleDeafen).map(ToString::to_string).as_deref(), Some("F16"));
        assert_eq!(*os.grabbed.borrow(), ["F16"]);
        assert_eq!(r.bind(Action::ToggleDeafen, "KeyM", &os), Err(HotkeyError::TypingKey));
    }

    #[test]
    fn finds_the_action_of_a_shortcut_and_reports_press_and_release() {
        let os = FakeOs::default();
        let hotkeys = Hotkeys::default();
        assert!(hotkeys.bind(Action::PushToTalk, "F13", &os).is_ok());
        assert!(hotkeys.bind(Action::ToggleMute, "Ctrl+Alt+KeyM", &os).is_ok());
        let f13 = Shortcut::new(None, Code::F13);
        let mute = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);
        let other = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyM);
        assert_eq!(hotkeys.event_of(&f13, ShortcutState::Pressed), Some(HotkeyEvent { action: Action::PushToTalk, pressed: true }));
        assert_eq!(hotkeys.event_of(&f13, ShortcutState::Released), Some(HotkeyEvent { action: Action::PushToTalk, pressed: false }));
        assert_eq!(hotkeys.event_of(&mute, ShortcutState::Pressed).map(|e| e.action), Some(Action::ToggleMute));
        assert_eq!(hotkeys.event_of(&other, ShortcutState::Pressed), None);
        assert!(hotkeys.unbind(Action::PushToTalk, &os).is_ok());
        assert_eq!(hotkeys.event_of(&f13, ShortcutState::Pressed), None, "an unbound shortcut reports nothing");
        assert_eq!(hotkeys.bind(Action::Priority, "Ctrl+Alt+KeyM", &os), Err(HotkeyError::Duplicate(Action::ToggleMute)));
    }

    #[test]
    fn actions_and_events_have_the_client_s_names() {
        assert_eq!(serde_json::to_value(Action::PushToTalk).ok(), Some(serde_json::json!("push_to_talk")));
        assert_eq!(serde_json::from_value::<Action>(serde_json::json!("toggle_deafen")).ok(), Some(Action::ToggleDeafen));
        assert!(serde_json::from_value::<Action>(serde_json::json!("shutdown")).is_err());
        let e = HotkeyEvent { action: Action::Priority, pressed: true };
        assert_eq!(serde_json::to_value(e).ok(), Some(serde_json::json!({ "action": "priority", "pressed": true })));
    }
}
