// SPDX-License-Identifier: Apache-2.0
//! The system-wide key listener of the Electron shell (docs/DESKTOP.md "Hotkeys"): a Node-API module around the crate
//! `keywatch` (`apps/desktop/crates/keywatch`), which the Tauri shell uses too. It **observes** the presses and
//! releases of the keys it is told to watch and **never grabs** them (X RECORD on Linux, the low-level hook on
//! Windows): the program with the focus still gets every key. The hotkey matching (bindings, combinations, the
//! "enabled" switch) is the main process's (`src/main/hotkeys.ts`); this module only reports the watched keys.
//!
//! ```js
//! keywatch.setKeys(["ControlLeft", "KeyM"]);   // the filter: every other key is dropped in the platform callback
//! keywatch.start((code, pressed) => { … });    // KeyboardEvent.code names; throws "keywatch.unavailable: <why>"
//! keywatch.stop();
//! ```
//!
//! Nothing is stored or logged: keys outside the filter never leave the platform callback, and what passes goes to the
//! callback only.

use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use std::thread::JoinHandle;

use keywatch::{Key, KeyFilter, RawKey, Watcher};
use napi::bindgen_prelude::FnArgs;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;

/// The callback: `(code, pressed)`, called on the main thread of JavaScript; weak, so it never keeps the process alive.
type KeyCallback = ThreadsafeFunction<FnArgs<(String, bool)>, (), FnArgs<(String, bool)>, Status, false, true>;

/// The most keys a filter may name (the key table has fewer; the bound keys and their modifiers are a handful).
const MAX_KEYS: usize = 256;

struct Running {
    watcher: Box<dyn Watcher>,
    dispatcher: JoinHandle<()>,
}

static FILTER: LazyLock<Arc<KeyFilter>> = LazyLock::new(Arc::default);
static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

/// The keys of `codes` (`KeyboardEvent.code` names of the key table); an unknown name is refused.
fn parse_keys(codes: &[String]) -> Result<Vec<Key>> {
    if codes.len() > MAX_KEYS {
        return Err(invalid("keywatch.invalid: too many keys"));
    }
    codes.iter().map(|c| Key::from_code(c).ok_or_else(|| invalid(format!("keywatch.invalid: unknown key {:?}", truncate(c))))).collect()
}

fn truncate(s: &str) -> &str {
    s.char_indices().nth(32).map_or(s, |(i, _)| &s[..i])
}

/// Replaces the keys the listener reports (also while it runs); every other key is dropped where the platform hands it
/// over.
#[napi]
pub fn set_keys(codes: Vec<String>) -> Result<()> {
    let keys = parse_keys(&codes)?;
    FILTER.set(keys);
    Ok(())
}

/// Starts the listener: the presses and releases of the filtered keys go to `callback(code, pressed)`. Throws
/// `keywatch.running` when it runs already and `keywatch.unavailable: <why>` when this system has no listener (no X
/// display, a Wayland session without XWayland, no RECORD extension, another platform).
#[napi(ts_args_type = "callback: (code: string, pressed: boolean) => void")]
pub fn start(callback: KeyCallback) -> Result<()> {
    let mut running = RUNNING.lock().map_err(|_| Error::from_reason("keywatch.unavailable: state poisoned"))?;
    if running.is_some() {
        return Err(Error::from_reason("keywatch.running"));
    }
    let (sink, raw) = mpsc::channel::<RawKey>();
    let watcher = keywatch::start(Arc::clone(&FILTER), sink).map_err(|e| Error::from_reason(format!("keywatch.unavailable: {}", e.0)))?;
    let dispatcher = std::thread::Builder::new()
        .name("tavrn-keywatch-js".into())
        .spawn(move || {
            // Ends when the watcher (which holds the sender) is dropped.
            for key in raw {
                let _ = callback.call(FnArgs::from((key.key.code().to_string(), key.pressed)), ThreadsafeFunctionCallMode::NonBlocking);
            }
        })
        .map_err(|e| Error::from_reason(format!("keywatch.unavailable: no thread: {e}")))?;
    *running = Some(Running { watcher, dispatcher });
    Ok(())
}

/// Stops the listener (nothing runs: nothing happens) and waits for its threads.
#[napi]
pub fn stop() {
    let running = RUNNING.lock().ok().and_then(|mut r| r.take());
    if let Some(Running { watcher, dispatcher }) = running {
        drop(watcher);
        let _ = dispatcher.join();
    }
}

/// Whether the listener runs.
#[napi]
pub fn is_running() -> bool {
    RUNNING.lock().is_ok_and(|r| r.is_some())
}
