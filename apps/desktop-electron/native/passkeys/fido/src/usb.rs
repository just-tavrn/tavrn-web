// SPDX-License-Identifier: Apache-2.0
//! A ceremony with the FIDO security keys on USB (HID), through the crate's state machine: it finds the keys (and
//! keys plugged in while it waits), lets the user pick one by touching it when there are several, runs the CTAP2 PIN
//! protocol when the key needs user verification, and sends the request. What the user has to do arrives as
//! [`Event`]s; the PIN and the choice of an account go back through [`Replies`]. Nothing here logs or keeps the PIN:
//! it goes from [`Replies::pin`] straight to the crate, which hashes and encrypts it for the key.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use authenticator::authenticatorservice::{AuthenticatorService, RegisterArgs, SignArgs};
use authenticator::errors::AuthenticatorError;
use authenticator::statecallback::StateCallback;
use authenticator::{Pin, RegisterResult, SignResult, StatusPinUv, StatusUpdate};

/// What the user has to do, or why the key refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The request reached a key: touch it.
    Touch,
    /// Several keys are plugged in: touch the one to use.
    SelectKey,
    /// The key wants its PIN ([`Replies::pin`]); `invalid` after a wrong one, with the tries left when the key says.
    Pin { invalid: bool, retries: Option<u8> },
    /// The key holds several passkeys of this site: the user picks one ([`Replies::account`]) by its names.
    SelectAccount(Vec<String>),
    /// The key's own user verification (a fingerprint on the key) failed; it may ask again or fall back to the PIN.
    UvInvalid { retries: Option<u8> },
    /// The ceremony ends because of the key's PIN: `pin_blocked` (reset the key), `pin_auth_blocked` (too many wrong
    /// PINs: unplug the key and plug it in again), `pin_not_set` (the node requires a PIN the key does not have),
    /// `uv_blocked`, `pin_length` (the key refused the PIN's length).
    Problem(&'static str),
}

/// Where the user's answers go: the PIN for the waiting key, the chosen account.
#[derive(Default)]
pub struct Replies {
    state: Mutex<Pending>,
}

#[derive(Default)]
struct Pending {
    pin: Option<Sender<Pin>>,
    account: Option<Sender<Option<usize>>>,
    cancelled: bool,
}

impl Replies {
    /// Hands the PIN to the key that asked for it (None cancels); false when no key waits for one.
    pub fn pin(&self, pin: Option<&str>) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        match (state.pin.take(), pin) {
            (Some(tx), Some(pin)) => tx.send(Pin::new(pin)).is_ok(),
            // Dropping the sender ends the ceremony as cancelled.
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    /// The account the user chose (an index of [`Event::SelectAccount`]'s list; None cancels).
    pub fn account(&self, index: Option<usize>) -> bool {
        let Ok(mut state) = self.state.lock() else { return false };
        state.account.take().is_some_and(|tx| tx.send(index).is_ok())
    }

    /// Drops whatever waits for the user: the ceremony ends as cancelled.
    fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.cancelled = true;
            state.pin = None;
            state.account = None;
        }
    }

    fn cancelled(&self) -> bool {
        self.state.lock().map(|s| s.cancelled).unwrap_or(true)
    }

    fn wait_for_pin(&self, tx: Sender<Pin>) -> bool {
        self.state.lock().map(|mut s| (!s.cancelled).then(|| s.pin = Some(tx)).is_some()).unwrap_or(false)
    }

    fn wait_for_account(&self, tx: Sender<Option<usize>>) -> bool {
        self.state.lock().map(|mut s| (!s.cancelled).then(|| s.account = Some(tx)).is_some()).unwrap_or(false)
    }
}

/// The status updates of the crate as [`Event`]s; the senders of the PIN and the account wait in `replies`.
fn event(update: StatusUpdate, replies: &Replies) -> Option<Event> {
    match update {
        StatusUpdate::PresenceRequired => Some(Event::Touch),
        StatusUpdate::SelectDeviceNotice => Some(Event::SelectKey),
        StatusUpdate::PinUvError(StatusPinUv::PinRequired(tx)) => replies.wait_for_pin(tx).then_some(Event::Pin { invalid: false, retries: None }),
        StatusUpdate::PinUvError(StatusPinUv::InvalidPin(tx, retries)) => replies.wait_for_pin(tx).then_some(Event::Pin { invalid: true, retries }),
        StatusUpdate::PinUvError(StatusPinUv::InvalidUv(retries)) => Some(Event::UvInvalid { retries }),
        StatusUpdate::PinUvError(StatusPinUv::PinBlocked) => Some(Event::Problem("pin_blocked")),
        StatusUpdate::PinUvError(StatusPinUv::PinAuthBlocked) => Some(Event::Problem("pin_auth_blocked")),
        StatusUpdate::PinUvError(StatusPinUv::PinNotSet) => Some(Event::Problem("pin_not_set")),
        StatusUpdate::PinUvError(StatusPinUv::UvBlocked) => Some(Event::Problem("uv_blocked")),
        StatusUpdate::PinUvError(StatusPinUv::PinIsTooShort | StatusPinUv::PinIsTooLong(_)) => Some(Event::Problem("pin_length")),
        StatusUpdate::SelectResultNotice(tx, users) => {
            let names = users.iter().map(|u| u.display_name.clone().or_else(|| u.name.clone()).unwrap_or_default()).collect();
            replies.wait_for_account(tx).then_some(Event::SelectAccount(names))
        }
        StatusUpdate::InteractiveManagement(_) => None,
    }
}

/// A ceremony in progress.
pub struct Running<T> {
    service: Arc<Mutex<AuthenticatorService>>,
    replies: Arc<Replies>,
    result: Receiver<authenticator::Result<T>>,
    events: Option<JoinHandle<()>>,
}

/// Cancels a running ceremony from another thread.
#[derive(Clone)]
pub struct Canceller {
    service: Arc<Mutex<AuthenticatorService>>,
    replies: Arc<Replies>,
}

impl Canceller {
    /// Ends the ceremony as cancelled (the key stops blinking; `wait` answers `passkey.cancelled`).
    pub fn cancel(&self) {
        // First what waits for the user (a key thread blocks on the PIN), then the transport.
        self.replies.cancel();
        if let Ok(mut service) = self.service.lock() {
            let _ = service.cancel();
        }
    }
}

impl<T> Running<T> {
    pub fn replies(&self) -> Arc<Replies> {
        Arc::clone(&self.replies)
    }

    pub fn canceller(&self) -> Canceller {
        Canceller { service: Arc::clone(&self.service), replies: Arc::clone(&self.replies) }
    }

    /// Waits for the key's answer (at most the timeout the ceremony was started with). After a cancel every failure is
    /// the cancel (the transport may report a cancel during its start as a platform error).
    pub fn wait(mut self) -> Result<T, AuthenticatorError> {
        let result = match self.result.recv() {
            Ok(Err(_)) | Err(_) if self.replies.cancelled() => Err(AuthenticatorError::CancelledByUser),
            Ok(result) => result,
            Err(_) => Err(AuthenticatorError::CancelledByUser),
        };
        self.replies.cancel();
        if let Some(events) = self.events.take() {
            let _ = events.join();
        }
        result
    }
}

type Start<A, T> = fn(&mut AuthenticatorService, u64, A, Sender<StatusUpdate>, StateCallback<authenticator::Result<T>>) -> authenticator::Result<()>;

fn start<A, T: Send + 'static>(
    args: A,
    timeout_ms: u32,
    on_event: impl Fn(Event) + Send + 'static,
    run: Start<A, T>,
) -> Result<Running<T>, AuthenticatorError> {
    let mut service = AuthenticatorService::new()?;
    service.add_u2f_usb_hid_platform_transports();
    let replies = Arc::new(Replies::default());
    let (status_tx, status_rx) = channel::<StatusUpdate>();
    let (result_tx, result_rx) = channel();
    let callback = StateCallback::new(Box::new(move |result| {
        let _ = result_tx.send(result);
    }));
    let events = {
        let replies = Arc::clone(&replies);
        std::thread::Builder::new()
            .name("tavrn-fido-events".into())
            // Ends when the state machine drops its status sender (the ceremony is over).
            .spawn(move || {
                for update in status_rx {
                    if let Some(e) = event(update, &replies) {
                        on_event(e);
                    }
                }
            })
            .map_err(AuthenticatorError::Io)?
    };
    run(&mut service, u64::from(timeout_ms), args, status_tx, callback)?;
    Ok(Running { service: Arc::new(Mutex::new(service)), replies, result: result_rx, events: Some(events) })
}

/// Starts a registration with the keys on USB.
pub fn register(args: RegisterArgs, timeout_ms: u32, on_event: impl Fn(Event) + Send + 'static) -> Result<Running<RegisterResult>, AuthenticatorError> {
    start(args, timeout_ms, on_event, |s, t, a, st, cb| s.register(t, a, st, cb))
}

/// Starts an assertion with the keys on USB.
pub fn sign(args: SignArgs, timeout_ms: u32, on_event: impl Fn(Event) + Send + 'static) -> Result<Running<SignResult>, AuthenticatorError> {
    start(args, timeout_ms, on_event, |s, t, a, st, cb| s.sign(t, a, st, cb))
}

#[cfg(test)]
mod tests {
    use super::*;
    use authenticator::ctap2::server::PublicKeyCredentialUserEntity;

    #[test]
    fn status_updates_become_events_and_the_pin_reaches_the_key() {
        let replies = Replies::default();
        assert_eq!(event(StatusUpdate::PresenceRequired, &replies), Some(Event::Touch));
        assert_eq!(event(StatusUpdate::SelectDeviceNotice, &replies), Some(Event::SelectKey));
        assert!(!replies.pin(Some("1234")), "no key waits for a PIN");
        let (tx, rx) = channel();
        assert_eq!(event(StatusUpdate::PinUvError(StatusPinUv::PinRequired(tx)), &replies), Some(Event::Pin { invalid: false, retries: None }));
        assert!(replies.pin(Some("1234")));
        assert!(rx.recv().is_ok(), "the PIN went to the key");
        assert!(!replies.pin(Some("1234")), "once");
        let (tx, rx) = channel::<Pin>();
        assert_eq!(event(StatusUpdate::PinUvError(StatusPinUv::InvalidPin(tx, Some(2))), &replies), Some(Event::Pin { invalid: true, retries: Some(2) }));
        assert!(replies.pin(None), "a cancelled PIN prompt");
        assert!(rx.recv().is_err(), "the key's thread sees the sender dropped: cancelled");
        for (status, problem) in [
            (StatusPinUv::PinBlocked, "pin_blocked"),
            (StatusPinUv::PinAuthBlocked, "pin_auth_blocked"),
            (StatusPinUv::PinNotSet, "pin_not_set"),
            (StatusPinUv::UvBlocked, "uv_blocked"),
            (StatusPinUv::PinIsTooShort, "pin_length"),
        ] {
            assert_eq!(event(StatusUpdate::PinUvError(status), &replies), Some(Event::Problem(problem)));
        }
        assert_eq!(event(StatusUpdate::PinUvError(StatusPinUv::InvalidUv(Some(1))), &replies), Some(Event::UvInvalid { retries: Some(1) }));
    }

    #[test]
    fn several_passkeys_on_the_key_are_chosen_by_name() {
        let replies = Replies::default();
        let (tx, rx) = channel();
        let users = vec![
            PublicKeyCredentialUserEntity { id: vec![1], name: Some("alice".into()), display_name: Some("Alice".into()) },
            PublicKeyCredentialUserEntity { id: vec![2], name: Some("bob".into()), display_name: None },
        ];
        assert_eq!(event(StatusUpdate::SelectResultNotice(tx, users), &replies), Some(Event::SelectAccount(vec!["Alice".into(), "bob".into()])));
        assert!(replies.account(Some(1)));
        assert_eq!(rx.recv().ok(), Some(Some(1)));
    }

    #[test]
    fn after_a_cancel_nothing_waits_for_the_user() {
        let replies = Replies::default();
        replies.cancel();
        let (tx, rx) = channel();
        assert_eq!(event(StatusUpdate::PinUvError(StatusPinUv::PinRequired(tx)), &replies), None, "no prompt after a cancel");
        assert!(rx.recv().is_err(), "the key's thread ends as cancelled");
    }
}
