// SPDX-License-Identifier: Apache-2.0
//! Native passkeys of the Linux app (docs/DESKTOP.md "Passkeys on Linux"): a Node-API module around the crate
//! `tavrn-fido` (`fido/`), loaded by the main process (`src/main/passkeys.ts`). One ceremony at a time:
//!
//! ```js
//! passkeys.keys();                                   // { present, usable }: FIDO keys plugged in, and openable
//! passkeys.create(optionsJson, origin, onEvent, onDone);  // throws "passkey.<code>" for options it refuses
//! passkeys.get(optionsJson, origin, onEvent, onDone);
//! // onEvent(json): {"kind":"touch"} | {"kind":"select_key"} | {"kind":"pin","invalid":false,"retries":null}
//! //   | {"kind":"accounts","names":[…]} | {"kind":"uv_invalid","retries":2} | {"kind":"problem","problem":"pin_blocked"}
//! // onDone(error, resultJson): error "passkey.<code>", or the `{ credential, prf }` JSON
//! passkeys.pin("1234");  passkeys.pin(null);         // answers a "pin" event (null cancels)
//! passkeys.account(0);   passkeys.account(null);     // answers an "accounts" event
//! passkeys.cancel();
//! ```
//!
//! `origin` is the connected node's web origin from the shell's settings, never the page's. The PIN goes from `pin`
//! straight to the security key's PIN protocol; nothing here keeps or logs it.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::FnArgs;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::{Value, json};

/// `onEvent(json)`: weak, it never keeps the process alive.
type EventCallback = ThreadsafeFunction<String, (), String, Status, false, true>;
/// `onDone(error, resultJson)`.
type DoneCallback = ThreadsafeFunction<FnArgs<(Option<String>, Option<String>)>, (), FnArgs<(Option<String>, Option<String>)>, Status, false>;

/// The largest options document the module reads (the node's are a few hundred bytes).
const MAX_OPTIONS: usize = 64 * 1024;

/// The FIDO security keys plugged in.
#[napi(object)]
pub struct KeyStatus {
    /// FIDO keys plugged in (HID interfaces with the FIDO usage page).
    pub present: u32,
    /// Of those, the ones this user may open (udev grants the seat's user access).
    pub usable: u32,
}

/// Whether this build has the USB transport (Linux).
#[napi]
pub fn available() -> bool {
    cfg!(target_os = "linux")
}

/// The FIDO security keys plugged in now (cheap: sysfs only, the keys are not touched).
#[napi]
pub fn keys() -> KeyStatus {
    let k = fido::devices::keys();
    KeyStatus { present: u32::try_from(k.present).unwrap_or(u32::MAX), usable: u32::try_from(k.usable).unwrap_or(u32::MAX) }
}

fn refused(code: &str) -> Error {
    Error::new(Status::GenericFailure, code.to_string())
}

fn parse(options: &str) -> Result<Value> {
    if options.len() > MAX_OPTIONS {
        return Err(refused(fido::FAILED));
    }
    serde_json::from_str(options).map_err(|_| refused(fido::FAILED))
}

#[cfg(target_os = "linux")]
mod running {
    use super::*;
    use fido::usb::{Canceller, Event, Replies};

    pub struct Current {
        pub replies: Arc<Replies>,
        pub canceller: Canceller,
    }

    pub static CURRENT: Mutex<Option<Current>> = Mutex::new(None);

    pub fn event_json(e: &Event) -> String {
        match e {
            Event::Touch => json!({ "kind": "touch" }),
            Event::SelectKey => json!({ "kind": "select_key" }),
            Event::Pin { invalid, retries } => json!({ "kind": "pin", "invalid": invalid, "retries": retries }),
            Event::SelectAccount(names) => json!({ "kind": "accounts", "names": names }),
            Event::UvInvalid { retries } => json!({ "kind": "uv_invalid", "retries": retries }),
            Event::Problem(problem) => json!({ "kind": "problem", "problem": problem }),
        }
        .to_string()
    }

    /// Runs one ceremony: starts it, keeps its handles for `pin`, `account` and `cancel`, and answers `on_done` from a
    /// thread of its own once the key answered (or the ceremony ended).
    pub fn run<T: Send + 'static>(
        start: impl FnOnce(Box<dyn Fn(Event) + Send>) -> std::result::Result<fido::usb::Running<T>, fido::authenticator::errors::AuthenticatorError>,
        finish: impl FnOnce(T) -> std::result::Result<fido::ctap::NativeResult, &'static str> + Send + 'static,
        on_event: EventCallback,
        on_done: DoneCallback,
    ) -> Result<()> {
        let mut current = CURRENT.lock().map_err(|_| refused(fido::FAILED))?;
        if current.is_some() {
            return Err(refused(fido::FAILED));
        }
        let events = Box::new(move |e: Event| {
            let _ = on_event.call(event_json(&e), ThreadsafeFunctionCallMode::NonBlocking);
        });
        let ceremony = start(events).map_err(|e| refused(fido::ctap::error_code(&e)))?;
        *current = Some(Current { replies: ceremony.replies(), canceller: ceremony.canceller() });
        drop(current);
        std::thread::Builder::new()
            .name("tavrn-fido-ceremony".into())
            .spawn(move || {
                let answer = ceremony.wait().map_err(|e| fido::ctap::error_code(&e)).and_then(finish);
                if let Ok(mut current) = CURRENT.lock() {
                    *current = None;
                }
                let args = match answer {
                    Ok(result) => (None, Some(serde_json::to_string(&result).unwrap_or_default())),
                    Err(code) => (Some(code.to_string()), None),
                };
                let _ = on_done.call(FnArgs::from(args), ThreadsafeFunctionCallMode::Blocking);
            })
            .map_err(|_| refused(fido::FAILED))?;
        Ok(())
    }
}

/// Registration: `options` is the node's `{ publicKey }` JSON, `origin` the node's web origin.
#[napi(ts_args_type = "options: string, origin: string, onEvent: (event: string) => void, onDone: (error: string | null, result: string | null) => void")]
pub fn create(options: String, origin: String, on_event: EventCallback, on_done: DoneCallback) -> Result<()> {
    let prepared = fido::ctap::prepare_create(&parse(&options)?, &origin).map_err(refused)?;
    #[cfg(target_os = "linux")]
    {
        let args = prepared.args.clone();
        let timeout = prepared.timeout_ms;
        running::run(move |events| fido::usb::register(args, timeout, events), move |r| fido::ctap::finish_create(&prepared, r), on_event, on_done)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (prepared, on_event, on_done);
        Err(refused(fido::UNAVAILABLE))
    }
}

/// Assertion: the node's `{ publicKey }` JSON, or the client's own one for the PRF unlock.
#[napi(ts_args_type = "options: string, origin: string, onEvent: (event: string) => void, onDone: (error: string | null, result: string | null) => void")]
pub fn get(options: String, origin: String, on_event: EventCallback, on_done: DoneCallback) -> Result<()> {
    let prepared = fido::ctap::prepare_get(&parse(&options)?, &origin).map_err(refused)?;
    #[cfg(target_os = "linux")]
    {
        let args = prepared.args.clone();
        let timeout = prepared.timeout_ms;
        running::run(move |events| fido::usb::sign(args, timeout, events), move |r| fido::ctap::finish_get(&prepared, r), on_event, on_done)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (prepared, on_event, on_done);
        Err(refused(fido::UNAVAILABLE))
    }
}

/// Answers the key's PIN request (null cancels the ceremony); false when no key waits for a PIN.
#[napi]
pub fn pin(pin: Option<String>) -> bool {
    #[cfg(target_os = "linux")]
    {
        let replies = running::CURRENT.lock().ok().and_then(|c| c.as_ref().map(|c| Arc::clone(&c.replies)));
        replies.is_some_and(|r| r.pin(pin.as_deref()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pin;
        false
    }
}

/// Answers the choice between several passkeys on the key (an index of the event's names; null cancels).
#[napi]
pub fn account(index: Option<u32>) -> bool {
    #[cfg(target_os = "linux")]
    {
        let replies = running::CURRENT.lock().ok().and_then(|c| c.as_ref().map(|c| Arc::clone(&c.replies)));
        replies.is_some_and(|r| r.account(index.map(|i| i as usize)))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = index;
        false
    }
}

/// Cancels the running ceremony (its `onDone` answers `passkey.cancelled`); nothing runs: nothing happens.
#[napi]
pub fn cancel() {
    #[cfg(target_os = "linux")]
    {
        let canceller = running::CURRENT.lock().ok().and_then(|c| c.as_ref().map(|c| c.canceller.clone()));
        if let Some(c) = canceller {
            c.cancel();
        }
    }
}
