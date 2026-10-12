// SPDX-License-Identifier: Apache-2.0
//! The key listener on Linux: the X RECORD extension. A recording context for the device events KeyPress and
//! KeyRelease of all clients; the data arrives on a second connection, as RECORD requires. RECORD only copies the
//! events, it takes nothing away from the program with the focus. Under Wayland it sees the keys of X11 programs
//! (XWayland: many games, Wine and Proton), not those of native Wayland windows.
//!
//! X11's key repeat sends a release and a press while a key is held; a release whose key is still down in the
//! server's key map (`QueryKeymap`) is such a repeat and is dropped.
//!
//! Both connections go to `DISPLAY` through x11rb (the file socket, then TCP) and, when that fails, through the Linux
//! abstract socket of the same display, which libxcb tries too: an X server that cannot create its file socket (a
//! read-only `/tmp/.X11-unix`, as for Xvfb under WSLg) listens there only.

use std::os::linux::net::SocketAddrExt as _;
use std::os::unix::net::{SocketAddr, UnixStream};
use std::sync::Arc;
use std::sync::mpsc::Sender;
use std::thread::JoinHandle;

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::record::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::reexports::x11rb_protocol::parse_display::parse_display_with_file_exists_callback;
use x11rb::reexports::x11rb_protocol::xauth::get_auth;
use x11rb::rust_connection::{DefaultStream, RustConnection};
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

/// A display on this machine's Unix socket (`:n`, `:n.s`, `unix/:n` in `DISPLAY`), parsed by x11rb's parser, which
/// follows libxcb's rules.
#[derive(Debug, PartialEq, Eq)]
struct LocalDisplay {
    display: u16,
    screen: u16,
}

impl LocalDisplay {
    /// `None` for a remote or TCP display (`host:n`, `tcp/:n`), a socket path and anything malformed.
    fn parse(name: &str) -> Option<Self> {
        let parsed = parse_display_with_file_exists_callback(name, |_| false).ok()?;
        let unix = parsed.host.is_empty() && parsed.protocol.as_deref().is_none_or(|p| p == "unix");
        unix.then_some(Self { display: parsed.display, screen: parsed.screen })
    }

    /// The name of the display's Linux abstract socket as libxcb has it (`@/tmp/.X11-unix/X<n>`, without the NUL).
    fn abstract_name(&self) -> String {
        format!("/tmp/.X11-unix/X{}", self.display)
    }
}

/// A connection to the X display of `DISPLAY` (both connections of the listener). x11rb tries the file socket
/// `/tmp/.X11-unix/X<n>` and TCP, not the Linux abstract socket; an X server that cannot create the file (a read-only
/// `/tmp/.X11-unix`, as under WSLg) listens on the abstract socket only, which libxcb (and Chromium with it) tries too.
/// So when x11rb fails, a local display gets a second try on its abstract socket.
fn connect() -> Result<RustConnection, Unavailable> {
    let error = match x11rb::connect(None) {
        Ok((conn, _)) => return Ok(conn),
        Err(e) => e,
    };
    let Some(display) = std::env::var("DISPLAY").ok().and_then(|d| LocalDisplay::parse(&d)) else {
        return Err(Unavailable(format!("no X display: {error}")));
    };
    connect_abstract(&display).map_err(|e| Unavailable(format!("no X display: {error} (abstract socket: {e})")))
}

/// Connects to `display`'s abstract socket with the authorization x11rb sends on the file socket: the Xauthority entry
/// of this host (`FamilyLocal`) for the display number, or none when there is no entry or no readable file.
fn connect_abstract(display: &LocalDisplay) -> Result<RustConnection, String> {
    let addr = SocketAddr::from_abstract_name(display.abstract_name()).map_err(|e| e.to_string())?;
    let stream = UnixStream::connect_addr(&addr).map_err(|e| e.to_string())?;
    let (stream, (family, address)) = DefaultStream::from_unix_stream(stream).map_err(|e| e.to_string())?;
    let (auth_name, auth_data) = get_auth(family, &address, display.display).ok().flatten().unwrap_or_default();
    RustConnection::connect_to_stream_with_auth_info(stream, usize::from(display.screen), auth_name, auth_data).map_err(|e| e.to_string())
}

pub fn start(filter: Arc<KeyFilter>, sink: Sender<RawKey>) -> Result<Box<dyn Watcher>, Unavailable> {
    let ctrl = connect()?;
    let data = connect()?;
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
    use std::sync::OnceLock;
    use std::time::Duration;

    #[test]
    fn the_abstract_socket_is_tried_for_local_displays_only() {
        let local = |display, screen| Some(LocalDisplay { display, screen });
        assert_eq!(LocalDisplay::parse(":0"), local(0, 0));
        assert_eq!(LocalDisplay::parse(":99"), local(99, 0));
        assert_eq!(LocalDisplay::parse(":12.1"), local(12, 1));
        assert_eq!(LocalDisplay::parse("unix/:3"), local(3, 0));
        // A host or another protocol means TCP; a path is a file socket; the rest is malformed.
        for other in ["localhost:10", "example.org:0.0", "tcp/:1", "inet6/[::1]:0", "/tmp/.X11-unix/X0", "", "wayland-0", ":x", ":0.x", ":70000"] {
            assert_eq!(LocalDisplay::parse(other), None, "{other:?}");
        }
        assert_eq!(LocalDisplay { display: 99, screen: 0 }.abstract_name(), "/tmp/.X11-unix/X99");
    }

    /// The display of `xvfb-run -a` (its XAUTHORITY), never a desktop's display; `None` (the test is skipped) elsewhere.
    /// The first call opens a connection that stays open until the tests end: Xvfb resets when its last client leaves and
    /// drops the connections that arrive meanwhile, which the parallel tests would otherwise race.
    fn xvfb_display() -> Option<LocalDisplay> {
        static KEEPALIVE: OnceLock<Option<RustConnection>> = OnceLock::new();
        let under_xvfb = std::env::var("XAUTHORITY").is_ok_and(|a| a.contains("xvfb-run"));
        let display = std::env::var("DISPLAY").ok().filter(|_| under_xvfb).and_then(|d| LocalDisplay::parse(&d));
        match display {
            Some(_) => {
                KEEPALIVE.get_or_init(|| connect().ok());
            }
            None => eprintln!("skipped: not under xvfb-run -a"),
        }
        display
    }

    fn round_trip(conn: &RustConnection) -> bool {
        conn.get_input_focus().is_ok_and(|c| c.reply().is_ok())
    }

    /// Under `xvfb-run -a`: on a normal system Xvfb has its file socket; where `/tmp/.X11-unix` is read-only (WSLg) it
    /// listens on the abstract socket only. Both must work.
    #[test]
    fn connects_to_the_display_of_xvfb_run_on_its_file_or_abstract_socket() {
        if xvfb_display().is_none() {
            return;
        }
        let conn = connect().unwrap_or_else(|e| unreachable!("{}", e.0));
        assert!(round_trip(&conn));
    }

    #[test]
    fn the_abstract_socket_carries_the_xauthority_cookie() {
        let Some(display) = xvfb_display() else { return };
        let conn = connect_abstract(&display).unwrap_or_else(|e| unreachable!("{e}"));
        assert!(round_trip(&conn));
        // xvfb-run's server requires the cookie: the same stream without it is refused.
        let addr = SocketAddr::from_abstract_name(display.abstract_name()).unwrap_or_else(|e| unreachable!("{e}"));
        let stream = UnixStream::connect_addr(&addr).unwrap_or_else(|e| unreachable!("{e}"));
        let (stream, _) = DefaultStream::from_unix_stream(stream).unwrap_or_else(|e| unreachable!("{e}"));
        assert!(RustConnection::connect_to_stream(stream, usize::from(display.screen)).is_err());
    }

    fn xdotool(args: &[&str]) {
        let ok = Command::new("xdotool").args(args).status().is_ok_and(|s| s.success());
        assert!(ok, "xdotool {args:?}");
    }

    /// The real X server: runs under `xvfb-run -a cargo test` with xdotool (the desktop smoke test covers the app).
    #[test]
    fn x11_reports_presses_and_releases_of_the_filtered_keys_only() {
        if xvfb_display().is_none() || Command::new("xdotool").arg("version").output().is_err() {
            return;
        }
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
