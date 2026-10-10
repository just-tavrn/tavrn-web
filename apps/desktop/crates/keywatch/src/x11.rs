// SPDX-License-Identifier: Apache-2.0
//! The key listener on Linux: the X RECORD extension. A recording context for the device events KeyPress and
//! KeyRelease of all clients; the data arrives on a second connection, as RECORD requires. RECORD only copies the
//! events, it takes nothing away from the program with the focus. Under Wayland it sees the keys of X11 programs
//! (XWayland: many games, Wine and Proton), not those of native Wayland windows.
//!
//! X11's key repeat sends a release and a press while a key is held; a release whose key is still down in the
//! server's key map (`QueryKeymap`) is such a repeat and is dropped.

use std::sync::Arc;
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::record::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use super::{Key, KeyFilter, RawKey, Unavailable, Watcher};

const RECORD_FROM_SERVER: u8 = 0;
const START_OF_DATA: u8 = 4;

struct Recording {
    ctrl: Arc<RustConnection>,
    context: record::Context,
    thread: Option<JoinHandle<()>>,
}

impl Watcher for Recording {}

impl Drop for Recording {
    fn drop(&mut self) {
        // Disabling the context ends the data connection's stream of replies, and with it the thread.
        let _ = self.ctrl.record_disable_context(self.context).map(|_| ());
        let _ = self.ctrl.sync();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = self.ctrl.record_free_context(self.context).map(|_| ());
        let _ = self.ctrl.flush();
    }
}

fn unavailable(what: &str) -> impl Fn(String) -> Unavailable + '_ {
    move |e| Unavailable(format!("{what}: {e}"))
}

pub fn start(filter: Arc<KeyFilter>, sink: Sender<RawKey>) -> Result<Box<dyn Watcher>, Unavailable> {
    let (ctrl, _) = x11rb::connect(None).map_err(|e| unavailable("no X display")(e.to_string()))?;
    let (data, _) = x11rb::connect(None).map_err(|e| unavailable("no X display")(e.to_string()))?;
    if ctrl.extension_information(record::X11_EXTENSION_NAME).map_err(|e| unavailable("RECORD")(e.to_string()))?.is_none() {
        return Err(Unavailable("the X server has no RECORD extension".into()));
    }
    ctrl.record_query_version(1, 13).map_err(|e| unavailable("RECORD")(e.to_string()))?.reply().map_err(|e| unavailable("RECORD")(e.to_string()))?;
    let context = ctrl.generate_id().map_err(|e| unavailable("RECORD")(e.to_string()))?;
    let empty = record::Range8 { first: 0, last: 0 };
    let empty_ext = record::ExtRange { major: empty, minor: record::Range16 { first: 0, last: 0 } };
    let range = record::Range {
        core_requests: empty,
        core_replies: empty,
        ext_requests: empty_ext,
        ext_replies: empty_ext,
        delivered_events: empty,
        device_events: record::Range8 { first: xproto::KEY_PRESS_EVENT, last: xproto::KEY_RELEASE_EVENT },
        errors: empty,
        client_started: false,
        client_died: false,
    };
    ctrl.record_create_context(context, 0, &[record::CS::ALL_CLIENTS.into()], &[range])
        .map_err(|e| unavailable("RECORD")(e.to_string()))?
        .check()
        .map_err(|e| unavailable("RECORD")(e.to_string()))?;
    let ctrl = Arc::new(ctrl);
    let keymap = Arc::clone(&ctrl);
    // The thread says when the recording runs (StartOfData): a disable sent before the enable would leave it waiting.
    let (ready_tx, ready) = std::sync::mpsc::channel::<bool>();
    let thread = std::thread::Builder::new()
        .name("tavrn-keywatch".into())
        .spawn(move || {
            let Ok(replies) = data.record_enable_context(context) else {
                let _ = ready_tx.send(false);
                return;
            };
            for reply in replies {
                let Ok(reply) = reply else { break };
                if reply.category == START_OF_DATA {
                    let _ = ready_tx.send(true);
                }
                if reply.client_swapped || reply.category != RECORD_FROM_SERVER {
                    continue;
                }
                for event in reply.data.as_chunks::<32>().0 {
                    let pressed = match event[0] & 0x7f {
                        xproto::KEY_PRESS_EVENT => true,
                        xproto::KEY_RELEASE_EVENT => false,
                        _ => continue,
                    };
                    let keycode = event[1];
                    // Every key outside the filter is dropped right here.
                    let Some(key) = Key::from_x11(keycode).filter(|k| filter.contains(*k)) else { continue };
                    if !pressed && still_down(&keymap, keycode) {
                        continue;
                    }
                    if sink.send(RawKey { key, pressed }).is_err() {
                        return;
                    }
                }
            }
        })
        .map_err(|e| Unavailable(format!("no thread: {e}")))?;
    let mut recording = Recording { ctrl, context, thread: Some(thread) };
    match ready.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(true) => Ok(Box::new(recording)),
        _ => {
            // Disable the context without waiting for the thread (it ends with its connection if it is stuck).
            recording.thread.take();
            drop(recording);
            Err(Unavailable("the X server did not start the recording".into()))
        }
    }
}

/// Whether the X server's key map has `keycode` down (a release of the key repeat).
fn still_down(conn: &RustConnection, keycode: u8) -> bool {
    conn.query_keymap()
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.keys.get(usize::from(keycode / 8)).copied())
        .is_some_and(|byte| byte & (1 << (keycode % 8)) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    fn xdotool(args: &[&str]) {
        let ok = Command::new("xdotool").args(args).status().is_ok_and(|s| s.success());
        assert!(ok, "xdotool {args:?}");
    }

    /// The real X server: run with `xvfb-run -a cargo test -- --ignored x11_` (the desktop smoke test covers the app).
    #[test]
    #[ignore = "needs an X display with RECORD and XTEST and xdotool"]
    fn x11_reports_presses_and_releases_of_the_filtered_keys_only() {
        let filter = Arc::new(KeyFilter::default());
        let watched: Vec<Key> = ["ControlLeft", "KeyV"].iter().filter_map(|c| Key::from_code(c)).collect();
        filter.set(watched.iter().copied());
        let (sink, raw) = std::sync::mpsc::channel();
        let watcher = start(Arc::clone(&filter), sink).unwrap_or_else(|e| unreachable!("{}", e.0));
        xdotool(&["keydown", "Control_L"]);
        xdotool(&["key", "a"]);
        xdotool(&["keyup", "Control_L"]);
        // Held past the key repeat delay: the repeat's releases are dropped.
        xdotool(&["keydown", "v"]);
        std::thread::sleep(Duration::from_millis(900));
        xdotool(&["keyup", "v"]);
        std::thread::sleep(Duration::from_millis(200));
        drop(watcher);
        let got: Vec<(&str, bool)> = raw.try_iter().map(|k| (k.key.code(), k.pressed)).collect();
        let presses_of_v = got.iter().filter(|(c, p)| *c == "KeyV" && *p).count();
        let releases_of_v = got.iter().filter(|(c, p)| *c == "KeyV" && !*p).count();
        assert_eq!(&got[..2], [("ControlLeft", true), ("ControlLeft", false)], "{got:?}");
        assert!(presses_of_v >= 1, "{got:?}");
        assert_eq!(releases_of_v, 1, "one release, the key repeat's are dropped: {got:?}");
        assert_eq!(got.last(), Some(&("KeyV", false)));
        assert!(!got.iter().any(|(c, _)| *c == "KeyA"), "an unwatched key never leaves the listener: {got:?}");
    }
}
