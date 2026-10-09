// SPDX-License-Identifier: Apache-2.0
//! Hotkeys of the voice client (docs/DESKTOP.md "Hotkeys"): push-to-talk and the priority speaker while held, mute and
//! deafen as toggles, also while the app is in the background or a game has the focus. The client keeps one binding
//! per action in its voice settings (the same key works in the window and globally) and registers the bindings here at
//! start and whenever they change; the shell validates a binding, refuses one that another action already uses and
//! reports presses and releases to the client over the channel of `listen_hotkeys`.
//!
//! The keys are **observed, never grabbed** (`keywatch`): every program still gets them, so a plain key (`KeyV`) or a
//! lone modifier (`ControlLeft`) can be push-to-talk while a game uses the same key. The listener runs only while
//! bindings exist and the client is signed in (`set_hotkeys_enabled`), and reports nothing but the bound actions.
//!
//! A binding is written as the client captures it: modifiers in a fixed order and one key as `KeyboardEvent.code`
//! names it, e.g. `ControlLeft`, `KeyV`, `F13`, `Ctrl+Shift+KeyM`. `Super` is the Windows key on Windows, Cmd on macOS
//! and Super/Meta on Linux; `Cmd`, `Win`, `Meta`, `Command`, `Control` and `Option` are accepted as spellings. A
//! modifier in a combination means either side (`Ctrl` is left or right Ctrl); a modifier key alone is exactly that
//! key (`ControlLeft` is only the left one).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::keywatch::{self, Key, KeyFilter, RawKey, Watcher};

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

/// Why a binding is refused; `code()` is what the client translates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyError {
    /// Not a binding the shell understands (unknown key, two keys, a modifier twice, empty).
    Invalid,
    /// Another action uses this binding.
    Duplicate(Action),
    /// The key listener cannot run on this system (the binding is kept and works while the window has focus).
    Unavailable,
}

impl HotkeyError {
    pub fn code(&self) -> &'static str {
        match self {
            HotkeyError::Invalid => "hotkey.invalid",
            HotkeyError::Duplicate(_) => "hotkey.duplicate",
            HotkeyError::Unavailable => "hotkey.unavailable",
        }
    }
}

/// The four modifiers of a combination, each standing for both of its keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Super,
}

impl Modifier {
    const ALL: [Modifier; 4] = [Modifier::Ctrl, Modifier::Alt, Modifier::Shift, Modifier::Super];

    fn name(self) -> &'static str {
        match self {
            Modifier::Ctrl => "Ctrl",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
            Modifier::Super => "Super",
        }
    }

    /// Its left and right key.
    fn keys(self) -> [&'static str; 2] {
        match self {
            Modifier::Ctrl => ["ControlLeft", "ControlRight"],
            Modifier::Alt => ["AltLeft", "AltRight"],
            Modifier::Shift => ["ShiftLeft", "ShiftRight"],
            Modifier::Super => ["MetaLeft", "MetaRight"],
        }
    }

    fn of_key(code: &str) -> Option<Modifier> {
        Modifier::ALL.into_iter().find(|m| m.keys().contains(&code))
    }
}

/// A validated binding: modifiers (either side) and one key, which may itself be a modifier key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// The Windows key, Cmd on macOS, Super/Meta on Linux.
    pub super_key: bool,
    pub key: Key,
}

/// The longest binding text the shell looks at.
const MAX_LEN: usize = 64;

impl Combo {
    /// Parses and validates a binding (see the module documentation).
    pub fn parse(text: &str) -> Result<Self, HotkeyError> {
        if text.is_empty() || text.len() > MAX_LEN {
            return Err(HotkeyError::Invalid);
        }
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let (key, modifiers) = parts.split_last().ok_or(HotkeyError::Invalid)?;
        let mut flags = [false; 4];
        for m in modifiers {
            let i = match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => 0,
                "alt" | "option" => 1,
                "shift" => 2,
                "super" | "meta" | "cmd" | "command" | "win" => 3,
                _ => return Err(HotkeyError::Invalid),
            };
            if flags[i] {
                return Err(HotkeyError::Invalid);
            }
            flags[i] = true;
        }
        let key = Key::from_code(key).ok_or(HotkeyError::Invalid)?;
        let combo = Combo { ctrl: flags[0], alt: flags[1], shift: flags[2], super_key: flags[3], key };
        // `Ctrl+ControlLeft` says the same thing twice.
        if Modifier::of_key(key.code()).is_some_and(|m| combo.has(m)) {
            return Err(HotkeyError::Invalid);
        }
        Ok(combo)
    }

    fn has(&self, m: Modifier) -> bool {
        match m {
            Modifier::Ctrl => self.ctrl,
            Modifier::Alt => self.alt,
            Modifier::Shift => self.shift,
            Modifier::Super => self.super_key,
        }
    }

    fn modifiers(&self) -> impl Iterator<Item = Modifier> + '_ {
        Modifier::ALL.into_iter().filter(|m| self.has(*m))
    }

    /// Every key the listener must watch for this binding: the key and both keys of each modifier.
    pub fn keys(&self) -> Vec<Key> {
        let mut keys = vec![self.key];
        keys.extend(self.modifiers().flat_map(Modifier::keys).filter_map(Key::from_code));
        keys
    }
}

/// The canonical spelling: `Ctrl+Alt+Shift+Super+<code>`, what the client stores.
impl fmt::Display for Combo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for m in self.modifiers() {
            write!(f, "{}+", m.name())?;
        }
        f.write_str(self.key.code())
    }
}

/// The bindings: at most one per action, never one binding for two actions.
#[derive(Debug, Default, Clone)]
pub struct Registry {
    bindings: BTreeMap<Action, Combo>,
}

impl Registry {
    /// Binds `text` to `action`; returns the canonical spelling.
    pub fn bind(&mut self, action: Action, text: &str) -> Result<String, HotkeyError> {
        let combo = Combo::parse(text)?;
        if let Some((other, _)) = self.bindings.iter().find(|(a, c)| **a != action && **c == combo) {
            return Err(HotkeyError::Duplicate(*other));
        }
        let canonical = combo.to_string();
        self.bindings.insert(action, combo);
        Ok(canonical)
    }

    /// Removes the binding of `action` (nothing bound: nothing happens).
    pub fn unbind(&mut self, action: Action) {
        self.bindings.remove(&action);
    }

    pub fn get(&self, action: Action) -> Option<&Combo> {
        self.bindings.get(&action)
    }

    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty()
    }

    /// The keys the listener must watch.
    pub fn keys(&self) -> Vec<Key> {
        self.bindings.values().flat_map(Combo::keys).collect()
    }
}

/// A press or release of a bound action, reported to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HotkeyEvent {
    pub action: Action,
    pub pressed: bool,
}

/// Turns the presses and releases of the watched keys into presses and releases of actions.
///
/// - An action is pressed when its key goes down while its modifiers are held (more modifiers may be held: Shift to
///   run while holding push-to-talk). Of the bindings with that key the one with the most modifiers wins, so
///   `Ctrl+Shift+KeyM` does not also fire `Ctrl+KeyM`.
/// - It is released when its key or one of its modifiers goes up.
/// - A press of a key that is already down (key repeat) changes nothing.
#[derive(Debug, Default)]
pub struct Matcher {
    down: HashSet<Key>,
    active: BTreeSet<Action>,
}

impl Matcher {
    fn modifier_held(&self, m: Modifier) -> bool {
        m.keys().iter().filter_map(|c| Key::from_code(c)).any(|k| self.down.contains(&k))
    }

    pub fn key(&mut self, raw: RawKey, registry: &Registry) -> Vec<HotkeyEvent> {
        let mut events = Vec::new();
        if raw.pressed {
            if !self.down.insert(raw.key) {
                return events;
            }
            let candidates: Vec<(Action, usize)> = registry
                .bindings
                .iter()
                .filter(|(_, c)| c.key == raw.key && c.modifiers().all(|m| self.modifier_held(m)))
                .map(|(a, c)| (*a, c.modifiers().count()))
                .collect();
            let best = candidates.iter().map(|(_, n)| *n).max();
            for (action, _) in candidates.into_iter().filter(|(_, n)| Some(*n) == best) {
                if self.active.insert(action) {
                    events.push(HotkeyEvent { action, pressed: true });
                }
            }
        } else {
            if !self.down.remove(&raw.key) {
                return events;
            }
            let ended: Vec<Action> = self
                .active
                .iter()
                .copied()
                .filter(|a| registry.get(*a).is_none_or(|c| c.key == raw.key || c.modifiers().any(|m| !self.modifier_held(m))))
                .collect();
            for action in ended {
                self.active.remove(&action);
                events.push(HotkeyEvent { action, pressed: false });
            }
        }
        events
    }

    /// Ends the hold of `action` (its binding changed or went away: the release would never come).
    pub fn end(&mut self, action: Action) -> Option<HotkeyEvent> {
        self.active.remove(&action).then_some(HotkeyEvent { action, pressed: false })
    }

    /// Forgets every key and ends every hold (the listener stopped).
    pub fn reset(&mut self) -> Vec<HotkeyEvent> {
        self.down.clear();
        std::mem::take(&mut self.active).into_iter().map(|action| HotkeyEvent { action, pressed: false }).collect()
    }
}

/// Where the listener comes from: the platform's in the app, a fake in the tests.
pub trait Listener: Send + Sync {
    fn start(&self, filter: Arc<KeyFilter>, sink: mpsc::Sender<RawKey>) -> Result<Box<dyn Watcher>, keywatch::Unavailable>;
}

/// The platform's key listener (`keywatch`).
pub struct OsListener;

impl Listener for OsListener {
    fn start(&self, filter: Arc<KeyFilter>, sink: mpsc::Sender<RawKey>) -> Result<Box<dyn Watcher>, keywatch::Unavailable> {
        keywatch::start(filter, sink)
    }
}

type Emit = Box<dyn Fn(HotkeyEvent) + Send>;

/// What the dispatcher thread shares with the commands: the bindings, the matcher and the client's channel.
#[derive(Default)]
struct Shared {
    registry: Mutex<Registry>,
    matcher: Mutex<Matcher>,
    emit: Mutex<Option<Emit>>,
    /// The shell's own listener (push-to-talk of the native voice engine), called before the client's channel.
    tap: Mutex<Option<Emit>>,
}

impl Shared {
    fn send(&self, events: impl IntoIterator<Item = HotkeyEvent>) {
        let events: Vec<HotkeyEvent> = events.into_iter().collect();
        if let Ok(tap) = self.tap.lock()
            && let Some(tap) = tap.as_ref()
        {
            for e in &events {
                tap(e.clone());
            }
        }
        if let Ok(emit) = self.emit.lock()
            && let Some(emit) = emit.as_ref()
        {
            for e in events {
                emit(e);
            }
        }
    }

    /// The dispatcher: raw keys of the listener in, action events to the client out (ends with the listener).
    fn dispatch(&self, raw: Receiver<RawKey>) {
        for key in raw {
            let events = match (self.registry.lock(), self.matcher.lock()) {
                (Ok(registry), Ok(mut matcher)) => matcher.key(key, &registry),
                _ => continue,
            };
            self.send(events);
        }
    }
}

/// The running listener and the thread that dispatches its keys.
struct Running {
    watcher: Box<dyn Watcher>,
    dispatcher: std::thread::JoinHandle<()>,
}

/// The hotkeys of the app: bindings, whether the client is signed in, the listener while both call for it.
pub struct Hotkeys {
    shared: Arc<Shared>,
    filter: Arc<KeyFilter>,
    listener: Box<dyn Listener>,
    state: Mutex<(bool, Option<Running>)>,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self::new(Box::new(OsListener))
    }
}

impl Hotkeys {
    pub fn new(listener: Box<dyn Listener>) -> Self {
        Self { shared: Arc::default(), filter: Arc::default(), listener, state: Mutex::new((false, None)) }
    }

    /// Where the action events go (the client's channel; a reloaded page replaces it).
    pub fn set_emit(&self, emit: impl Fn(HotkeyEvent) + Send + 'static) {
        if let Ok(mut e) = self.shared.emit.lock() {
            *e = Some(Box::new(emit));
        }
    }

    /// The shell's own listener of the action events (the native voice engine's push-to-talk), next to the client's.
    pub fn set_tap(&self, tap: impl Fn(HotkeyEvent) + Send + 'static) {
        if let Ok(mut t) = self.shared.tap.lock() {
            *t = Some(Box::new(tap));
        }
    }

    /// Binds `text` to `action` (see [`Registry::bind`]); a hold of the old binding ends.
    pub fn bind(&self, action: Action, text: &str) -> Result<String, HotkeyError> {
        let canonical = {
            let mut registry = self.shared.registry.lock().map_err(|_| HotkeyError::Unavailable)?;
            let old = registry.get(action).cloned();
            let canonical = registry.bind(action, text)?;
            if old.as_ref() != registry.get(action) {
                self.end(action);
            }
            canonical
        };
        self.update().map(|_| canonical)
    }

    /// Removes the binding of `action`; a hold of it ends.
    pub fn unbind(&self, action: Action) -> Result<(), HotkeyError> {
        self.shared.registry.lock().map_err(|_| HotkeyError::Unavailable)?.unbind(action);
        self.end(action);
        self.update().map(|_| ())
    }

    /// The client signed in or out: the listener runs only while signed in. Returns whether it runs now.
    pub fn set_enabled(&self, enabled: bool) -> Result<bool, HotkeyError> {
        self.state.lock().map_err(|_| HotkeyError::Unavailable)?.0 = enabled;
        self.update()
    }

    /// Whether the listener runs.
    pub fn running(&self) -> bool {
        self.state.lock().is_ok_and(|s| s.1.is_some())
    }

    fn end(&self, action: Action) {
        let ended = self.shared.matcher.lock().ok().and_then(|mut m| m.end(action));
        self.shared.send(ended);
    }

    /// Starts or stops the listener as the bindings and the sign-in call for it, and hands it the keys to watch.
    fn update(&self) -> Result<bool, HotkeyError> {
        let keys = self.shared.registry.lock().map_err(|_| HotkeyError::Unavailable)?.keys();
        let mut state = self.state.lock().map_err(|_| HotkeyError::Unavailable)?;
        let wanted = state.0 && !keys.is_empty();
        self.filter.set(if wanted { keys } else { Vec::new() });
        match (wanted, state.1.is_some()) {
            (true, false) => {
                let (sink, raw) = mpsc::channel();
                let watcher = self.listener.start(Arc::clone(&self.filter), sink).map_err(|e| {
                    eprintln!("tavrn: no key listener: {}", e.0);
                    HotkeyError::Unavailable
                })?;
                let shared = Arc::clone(&self.shared);
                let dispatcher =
                    std::thread::Builder::new().name("tavrn-hotkeys".into()).spawn(move || shared.dispatch(raw)).map_err(|_| HotkeyError::Unavailable)?;
                state.1 = Some(Running { watcher, dispatcher });
            }
            (false, true) => {
                if let Some(running) = state.1.take() {
                    // The watcher holds the sender: dropping it ends the dispatcher.
                    drop(running.watcher);
                    let _ = running.dispatcher.join();
                }
                let released = self.shared.matcher.lock().map(|mut m| m.reset()).unwrap_or_default();
                self.shared.send(released);
            }
            _ => {}
        }
        Ok(state.1.is_some())
    }
}

/// Binds a key or combination to an action; returns its canonical spelling or an error code (`hotkey.*`).
/// `hotkey.unavailable` keeps the binding: the system has no key listener, the key works while the window has focus.
#[tauri::command]
pub fn register_hotkey(hotkeys: State<'_, Hotkeys>, action: Action, combo: String) -> Result<String, String> {
    hotkeys.bind(action, &combo).map_err(|e| e.code().to_string())
}

/// Removes the binding of an action.
#[tauri::command]
pub fn unregister_hotkey(hotkeys: State<'_, Hotkeys>, action: Action) -> Result<(), String> {
    hotkeys.unbind(action).map_err(|e| e.code().to_string())
}

/// The client's channel for presses and releases of the bound actions.
#[tauri::command]
pub fn listen_hotkeys(hotkeys: State<'_, Hotkeys>, on_event: Channel<HotkeyEvent>) -> Result<(), String> {
    hotkeys.set_emit(move |e| {
        let _ = on_event.send(e);
    });
    Ok(())
}

/// The client signed in (`true`) or out: the key listener runs only while signed in and bindings exist. Returns whether
/// the listener runs now; `hotkey.unavailable` when it should but cannot.
#[tauri::command]
pub fn set_hotkeys_enabled(hotkeys: State<'_, Hotkeys>, enabled: bool) -> Result<bool, String> {
    hotkeys.set_enabled(enabled).map_err(|e| e.code().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn key(code: &str) -> Key {
        Key::from_code(code).unwrap_or_else(|| unreachable!("{code}"))
    }

    fn canonical(text: &str) -> Result<String, HotkeyError> {
        Combo::parse(text).map(|c| c.to_string())
    }

    #[test]
    fn parses_and_formats_bindings_in_a_fixed_order() {
        assert_eq!(canonical("Ctrl+Shift+KeyM"), Ok("Ctrl+Shift+KeyM".into()));
        assert_eq!(canonical("shift+control+KeyM"), Ok("Ctrl+Shift+KeyM".into()));
        assert_eq!(canonical("Super+Alt+Shift+Ctrl+Digit1"), Ok("Ctrl+Alt+Shift+Super+Digit1".into()));
        assert_eq!(canonical("F13"), Ok("F13".into()));
        assert_eq!(canonical("Alt + Numpad1"), Ok("Alt+Numpad1".into()));
        assert_eq!(canonical("Option+KeyT"), Ok("Alt+KeyT".into()));
        for spelling in ["Super+KeyM", "Cmd+KeyM", "Command+KeyM", "Win+KeyM", "Meta+KeyM", "SUPER+KeyM"] {
            assert_eq!(canonical(spelling), Ok("Super+KeyM".into()), "{spelling}");
        }
    }

    #[test]
    fn plain_keys_and_lone_modifiers_are_bindings_now() {
        for single in ["KeyV", "Backquote", "Space", "ControlLeft", "ShiftRight", "AltRight", "MetaLeft", "CapsLock", "Digit1", "Enter"] {
            assert_eq!(canonical(single), Ok(single.into()), "{single}");
        }
        assert_eq!(canonical("Shift+ControlLeft"), Ok("Shift+ControlLeft".into()), "another modifier with a modifier key");
    }

    #[test]
    fn refuses_invalid_bindings() {
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
            "Ctrl+ControlLeft",
            "Shift+ShiftRight",
            "Ctrl+Unknown",
            "Ctrl+F25",
        ] {
            assert_eq!(Combo::parse(bad), Err(HotkeyError::Invalid), "{bad:?}");
        }
        assert_eq!(Combo::parse(&format!("Ctrl+{}", "K".repeat(70))), Err(HotkeyError::Invalid));
    }

    #[test]
    fn a_combination_watches_its_key_and_both_sides_of_its_modifiers() {
        let keys = |t: &str| Combo::parse(t).map(|c| c.keys().into_iter().map(Key::code).collect::<Vec<_>>()).unwrap_or_default();
        assert_eq!(keys("ControlLeft"), ["ControlLeft"]);
        assert_eq!(keys("Ctrl+Shift+KeyM"), ["KeyM", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"]);
    }

    #[test]
    fn binds_replaces_and_refuses_duplicates() {
        let mut r = Registry::default();
        assert_eq!(r.bind(Action::ToggleMute, "ctrl+shift+KeyM"), Ok("Ctrl+Shift+KeyM".into()));
        assert_eq!(r.bind(Action::ToggleMute, "F14"), Ok("F14".into()));
        assert_eq!(r.get(Action::ToggleMute).map(ToString::to_string).as_deref(), Some("F14"));
        assert_eq!(r.bind(Action::PushToTalk, "F14"), Err(HotkeyError::Duplicate(Action::ToggleMute)));
        assert_eq!(r.bind(Action::PushToTalk, "F14").map_err(|e| e.code()), Err("hotkey.duplicate"));
        assert!(r.get(Action::PushToTalk).is_none());
        assert_eq!(r.bind(Action::PushToTalk, "Ctrl+F14"), Ok("Ctrl+F14".into()), "a combination with the key is another binding");
        r.unbind(Action::ToggleMute);
        r.unbind(Action::ToggleMute);
        assert!(r.get(Action::ToggleMute).is_none());
    }

    /// Feeds key events (`+Code` press, `-Code` release) through a matcher.
    fn run(bindings: &[(Action, &str)], keys: &[&str]) -> Vec<(Action, bool)> {
        let mut r = Registry::default();
        for (a, t) in bindings {
            assert!(r.bind(*a, t).is_ok(), "{t}");
        }
        let mut m = Matcher::default();
        let mut out = Vec::new();
        for k in keys {
            let (pressed, code) = k.split_at(1);
            out.extend(m.key(RawKey { key: key(code), pressed: pressed == "+" }, &r).into_iter().map(|e| (e.action, e.pressed)));
        }
        out
    }

    #[test]
    fn matcher_a_single_key() {
        let ptt = [(Action::PushToTalk, "KeyV")];
        assert_eq!(run(&ptt, &["+KeyV", "-KeyV"]), [(Action::PushToTalk, true), (Action::PushToTalk, false)]);
        assert_eq!(run(&ptt, &["+KeyB", "-KeyB"]), [], "other keys do nothing");
        // Extra modifiers are fine: Shift to run while holding push-to-talk, pressed before or during the hold.
        assert_eq!(run(&ptt, &["+ShiftLeft", "+KeyV", "-ShiftLeft", "-KeyV"]), [(Action::PushToTalk, true), (Action::PushToTalk, false)]);
    }

    #[test]
    fn matcher_a_lone_modifier() {
        let ptt = [(Action::PushToTalk, "ControlLeft")];
        assert_eq!(run(&ptt, &["+ControlLeft", "+KeyC", "-KeyC", "-ControlLeft"]), [(Action::PushToTalk, true), (Action::PushToTalk, false)]);
        assert_eq!(run(&ptt, &["+ControlRight", "-ControlRight"]), [], "only the left one");
    }

    #[test]
    fn matcher_a_combination() {
        let mute = [(Action::ToggleMute, "Ctrl+Shift+KeyM")];
        assert_eq!(run(&mute, &["+ControlRight", "+ShiftLeft", "+KeyM", "-KeyM"]), [(Action::ToggleMute, true), (Action::ToggleMute, false)]);
        assert_eq!(run(&mute, &["+ShiftLeft", "+KeyM", "-KeyM"]), [], "Ctrl missing");
        assert_eq!(run(&mute, &["+KeyM", "+ControlLeft", "+ShiftLeft"]), [], "the key must come last");
        // Letting go of a modifier ends the hold.
        assert_eq!(run(&mute, &["+ControlLeft", "+ShiftLeft", "+KeyM", "-ShiftLeft", "-KeyM"]), [(Action::ToggleMute, true), (Action::ToggleMute, false)]);
        // The binding with more modifiers wins over the one it contains.
        let both = [(Action::ToggleMute, "Ctrl+KeyM"), (Action::ToggleDeafen, "Ctrl+Shift+KeyM")];
        assert_eq!(run(&both, &["+ControlLeft", "+ShiftLeft", "+KeyM", "-KeyM"]), [(Action::ToggleDeafen, true), (Action::ToggleDeafen, false)]);
        assert_eq!(run(&both, &["+ControlLeft", "+KeyM", "-KeyM"]), [(Action::ToggleMute, true), (Action::ToggleMute, false)]);
    }

    #[test]
    fn matcher_release_and_key_repeat() {
        let ptt = [(Action::PushToTalk, "KeyV"), (Action::Priority, "KeyB")];
        // Key repeat sends presses while the key is held: one press, one release.
        assert_eq!(run(&ptt, &["+KeyV", "+KeyV", "+KeyV", "-KeyV"]), [(Action::PushToTalk, true), (Action::PushToTalk, false)]);
        // A release without a press (the press happened before the listener started) does nothing.
        assert_eq!(run(&ptt, &["-KeyV"]), []);
        // Two actions held at once, released in any order.
        assert_eq!(
            run(&ptt, &["+KeyV", "+KeyB", "-KeyV", "-KeyB"]),
            [(Action::PushToTalk, true), (Action::Priority, true), (Action::PushToTalk, false), (Action::Priority, false)]
        );
    }

    #[test]
    fn matcher_ends_holds_when_asked() {
        let mut r = Registry::default();
        assert!(r.bind(Action::PushToTalk, "KeyV").is_ok());
        let mut m = Matcher::default();
        assert_eq!(m.key(RawKey { key: key("KeyV"), pressed: true }, &r).len(), 1);
        assert_eq!(m.end(Action::PushToTalk), Some(HotkeyEvent { action: Action::PushToTalk, pressed: false }));
        assert_eq!(m.end(Action::PushToTalk), None);
        assert_eq!(m.key(RawKey { key: key("KeyV"), pressed: true }, &r), [], "still down: a repeat");
        assert_eq!(m.reset(), []);
        assert_eq!(m.key(RawKey { key: key("KeyV"), pressed: true }, &r).len(), 1, "after a reset the next press counts");
        assert_eq!(m.reset(), [HotkeyEvent { action: Action::PushToTalk, pressed: false }]);
    }

    /// The filter and the sink of a running fake listener.
    type Slot = Arc<Mutex<Option<(Arc<KeyFilter>, mpsc::Sender<RawKey>)>>>;

    /// A listener that records starts and stops and lets the test press keys.
    #[derive(Clone, Default)]
    struct FakeListener {
        starts: Arc<AtomicUsize>,
        stops: Arc<AtomicUsize>,
        sink: Slot,
        refuse: bool,
    }

    struct FakeWatcher(Arc<AtomicUsize>, Slot);

    impl Watcher for FakeWatcher {}

    impl Drop for FakeWatcher {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut s) = self.1.lock() {
                *s = None;
            }
        }
    }

    impl Listener for FakeListener {
        fn start(&self, filter: Arc<KeyFilter>, sink: mpsc::Sender<RawKey>) -> Result<Box<dyn Watcher>, keywatch::Unavailable> {
            if self.refuse {
                return Err(keywatch::Unavailable("no display".into()));
            }
            self.starts.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut s) = self.sink.lock() {
                *s = Some((filter, sink));
            }
            Ok(Box::new(FakeWatcher(Arc::clone(&self.stops), Arc::clone(&self.sink))))
        }
    }

    impl FakeListener {
        /// A key as the platform would report it: only keys in the filter get through.
        fn press(&self, code: &str, pressed: bool) {
            if let Ok(s) = self.sink.lock()
                && let Some((filter, sink)) = s.as_ref()
                && filter.contains(key(code))
            {
                let _ = sink.send(RawKey { key: key(code), pressed });
            }
        }

        fn filtered(&self, code: &str) -> bool {
            self.sink.lock().ok().and_then(|s| s.as_ref().map(|(f, _)| f.contains(key(code)))).unwrap_or(false)
        }
    }

    fn hotkeys(listener: &FakeListener) -> (Hotkeys, Arc<Mutex<Vec<HotkeyEvent>>>) {
        let h = Hotkeys::new(Box::new(listener.clone()));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        h.set_emit(move |e| log.lock().map(|mut l| l.push(e)).unwrap_or_default());
        (h, seen)
    }

    fn wait_for(seen: &Mutex<Vec<HotkeyEvent>>, n: usize) -> Vec<HotkeyEvent> {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let now = seen.lock().map(|l| l.clone()).unwrap_or_default();
            if now.len() >= n || Instant::now() > end {
                return now;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn the_tap_hears_every_action_event_too() {
        let listener = FakeListener::default();
        let (h, seen) = hotkeys(&listener);
        let tapped = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&tapped);
        h.set_tap(move |e| log.lock().map(|mut l| l.push(e)).unwrap_or_default());
        assert!(h.bind(Action::PushToTalk, "ControlLeft").is_ok());
        assert_eq!(h.set_enabled(true), Ok(true));
        listener.press("ControlLeft", true);
        listener.press("ControlLeft", false);
        let events = wait_for(&seen, 2);
        assert_eq!(events, wait_for(&tapped, 2));
        assert_eq!(events, vec![HotkeyEvent { action: Action::PushToTalk, pressed: true }, HotkeyEvent { action: Action::PushToTalk, pressed: false }]);
    }

    #[test]
    fn the_listener_runs_only_while_signed_in_with_bindings() {
        let listener = FakeListener::default();
        let (h, _) = hotkeys(&listener);
        assert_eq!(h.bind(Action::PushToTalk, "ControlLeft"), Ok("ControlLeft".into()));
        assert!(!h.running(), "not signed in: no listener");
        assert_eq!(h.set_enabled(true), Ok(true));
        assert_eq!(listener.starts.load(Ordering::SeqCst), 1);
        assert!(h.bind(Action::ToggleMute, "Ctrl+Shift+KeyM").is_ok());
        assert_eq!(listener.starts.load(Ordering::SeqCst), 1, "a new binding only changes the filter");
        assert!(listener.filtered("ShiftRight") && listener.filtered("KeyM") && listener.filtered("ControlLeft"));
        assert!(!listener.filtered("KeyA"), "keys of no binding are dropped by the platform callback");
        assert!(h.unbind(Action::PushToTalk).is_ok());
        assert!(h.unbind(Action::ToggleMute).is_ok());
        assert!(!h.running(), "no bindings: the listener stops");
        assert_eq!(listener.stops.load(Ordering::SeqCst), 1);
        assert!(h.bind(Action::Priority, "F13").is_ok());
        assert!(h.running());
        assert_eq!(h.set_enabled(false), Ok(false), "signed out: the listener stops");
        assert_eq!(listener.stops.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn presses_reach_the_client_as_actions_and_a_stop_releases_what_is_held() {
        let listener = FakeListener::default();
        let (h, seen) = hotkeys(&listener);
        assert!(h.bind(Action::PushToTalk, "ControlLeft").is_ok());
        assert!(h.bind(Action::ToggleMute, "Ctrl+Alt+KeyM").is_ok());
        assert_eq!(h.set_enabled(true), Ok(true));
        listener.press("ControlLeft", true);
        listener.press("KeyA", true);
        listener.press("ControlLeft", true);
        listener.press("ControlLeft", false);
        let events = wait_for(&seen, 2);
        assert_eq!(events, [HotkeyEvent { action: Action::PushToTalk, pressed: true }, HotkeyEvent { action: Action::PushToTalk, pressed: false }]);
        // Held while the client signs out: the hold ends with the listener.
        listener.press("ControlLeft", true);
        wait_for(&seen, 3);
        assert_eq!(h.set_enabled(false), Ok(false));
        let events = wait_for(&seen, 4);
        assert_eq!(events.get(3), Some(&HotkeyEvent { action: Action::PushToTalk, pressed: false }));
    }

    #[test]
    fn rebinding_a_held_action_releases_it() {
        let listener = FakeListener::default();
        let (h, seen) = hotkeys(&listener);
        assert!(h.bind(Action::PushToTalk, "KeyV").is_ok());
        assert_eq!(h.set_enabled(true), Ok(true));
        listener.press("KeyV", true);
        wait_for(&seen, 1);
        assert!(h.bind(Action::PushToTalk, "KeyV").is_ok(), "the same binding again keeps the hold");
        assert!(h.bind(Action::PushToTalk, "KeyB").is_ok());
        let events = wait_for(&seen, 2);
        assert_eq!(events, [HotkeyEvent { action: Action::PushToTalk, pressed: true }, HotkeyEvent { action: Action::PushToTalk, pressed: false }]);
    }

    #[test]
    fn without_a_listener_the_binding_stays_and_unavailable_is_reported() {
        let listener = FakeListener { refuse: true, ..FakeListener::default() };
        let (h, _) = hotkeys(&listener);
        assert_eq!(h.set_enabled(true), Ok(false), "nothing bound: nothing to start");
        assert_eq!(h.bind(Action::PushToTalk, "KeyV"), Err(HotkeyError::Unavailable));
        assert_eq!(HotkeyError::Unavailable.code(), "hotkey.unavailable");
        assert!(h.shared.registry.lock().is_ok_and(|r| r.get(Action::PushToTalk).is_some()), "kept for the window");
        assert_eq!(h.set_enabled(true), Err(HotkeyError::Unavailable));
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
