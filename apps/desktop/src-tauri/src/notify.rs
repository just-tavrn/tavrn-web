// SPDX-License-Identifier: Apache-2.0
//! Native notifications (docs/DESKTOP.md "Notifications"): the client asks for one while the window is not focused
//! (mentions, direct messages, incoming calls; never the content of an encrypted message, the client sends a fixed
//! text instead). Shown with notify-rust, the backend of tauri-plugin-notification, used directly because the plugin
//! has no click events on desktop and would replace the webview's `Notification` with an IPC bridge.
//!
//! A click focuses the window and opens the notification's path in the client: Linux through the notification
//! server's default action (GNOME, KDE and most others), Windows through the toast's activation while the app runs.
//! macOS (later) shows the notification only.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

use crate::events::{self, ShellEvent};

const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 1000;
const MAX_PATH: usize = 512;
/// Notifications whose click is awaited at the same time (each waits on its own thread until clicked or closed).
const MAX_WAITING: usize = 16;

static WAITING: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// A path of the client (`/rooms/…`, `/dm/…`) to open on a click.
    #[serde(default)]
    pub path: Option<String>,
}

/// Lengths, no control characters, and a path that stays inside the client (no scheme, no `//host`).
pub fn validate(n: &Notice) -> Result<(), &'static str> {
    let text_ok = |s: &str, max: usize| s.chars().count() <= max && !s.chars().any(|c| c.is_control() && c != '\n');
    if n.title.trim().is_empty() || !text_ok(&n.title, MAX_TITLE) || !text_ok(&n.body, MAX_BODY) {
        return Err("notify.invalid");
    }
    if let Some(path) = &n.path {
        let inside = path.starts_with('/') && !path.starts_with("//") && path.len() <= MAX_PATH;
        if !inside || path.chars().any(|c| c.is_control() || c == '\\' || c.is_whitespace()) {
            return Err("notify.invalid");
        }
    }
    Ok(())
}

/// Shows a notification; a click focuses the window and opens `path`.
#[tauri::command]
pub fn notify<R: Runtime>(app: AppHandle<R>, notice: Notice) -> Result<(), String> {
    validate(&notice).map_err(str::to_string)?;
    let mut n = notify_rust::Notification::new();
    n.summary(&notice.title).body(&notice.body).appname("Tavrn").auto_icon();
    #[cfg(target_os = "linux")]
    n.action("default", &notice.title);
    #[cfg(windows)]
    if installed() {
        // The Start menu entry of the installer carries this id; a development build uses the default one.
        n.app_id(&app.config().identifier);
    }
    let wait = WAITING.fetch_add(1, Ordering::SeqCst) < MAX_WAITING;
    if !wait {
        WAITING.fetch_sub(1, Ordering::SeqCst);
    }
    std::thread::spawn(move || {
        let shown = n.show();
        if !wait {
            return;
        }
        if let Ok(handle) = shown {
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                if clicked(response) {
                    events::show_main(&app);
                    if let Some(path) = notice.path {
                        events::send(&app, ShellEvent::Open { path });
                    }
                }
            });
        }
        WAITING.fetch_sub(1, Ordering::SeqCst);
    });
    Ok(())
}

/// The body of the notification was clicked (the default action).
pub fn clicked(response: &notify_rust::NotificationResponse) -> bool {
    use notify_rust::NotificationResponse as R;
    matches!(response, R::Default) || matches!(response, R::Action(a) if a == "default")
}

/// An installed app (not a build in a cargo target directory): Windows notifications then use the app's id.
#[cfg(windows)]
fn installed() -> bool {
    let Ok(exe) = tauri::utils::platform::current_exe() else { return false };
    let dir = exe.parent().map(|d| d.display().to_string()).unwrap_or_default();
    !(dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_rust::{CloseReason, NotificationResponse};

    fn notice(title: &str, body: &str, path: Option<&str>) -> Notice {
        Notice { title: title.into(), body: body.into(), path: path.map(str::to_string) }
    }

    #[test]
    fn ordinary_notices_pass() {
        assert_eq!(validate(&notice("Alice in #general · Room", "Hello there", Some("/rooms/1/channels/2"))), Ok(()));
        assert_eq!(validate(&notice("Incoming call from bob", "bob@tavrn.example", Some("/n/other.example/dm/3"))), Ok(()));
        assert_eq!(validate(&notice("Alice", "line one\nline two", None)), Ok(()));
    }

    #[test]
    fn paths_stay_inside_the_client() {
        for bad in ["https://evil.example/", "//evil.example/x", "rooms/1", "/rooms/1 x", "/a\\b", "javascript:alert(1)", ""] {
            assert_eq!(validate(&notice("t", "b", Some(bad))), Err("notify.invalid"), "{bad:?}");
        }
        assert_eq!(validate(&notice("t", "b", Some(&format!("/{}", "a".repeat(MAX_PATH))))), Err("notify.invalid"));
    }

    #[test]
    fn titles_and_bodies_are_bounded() {
        assert_eq!(validate(&notice("", "b", None)), Err("notify.invalid"));
        assert_eq!(validate(&notice("   ", "b", None)), Err("notify.invalid"));
        assert_eq!(validate(&notice(&"t".repeat(MAX_TITLE + 1), "b", None)), Err("notify.invalid"));
        assert_eq!(validate(&notice("t", &"b".repeat(MAX_BODY + 1), None)), Err("notify.invalid"));
        assert_eq!(validate(&notice("t\u{7}", "b", None)), Err("notify.invalid"));
        assert_eq!(validate(&notice(&"ü".repeat(MAX_TITLE), "b", None)), Ok(()), "characters, not bytes");
    }

    #[test]
    fn only_the_body_click_opens_the_conversation() {
        assert!(clicked(&NotificationResponse::Default));
        assert!(clicked(&NotificationResponse::Action("default".into())));
        assert!(!clicked(&NotificationResponse::Action("other".into())));
        assert!(!clicked(&NotificationResponse::Closed(CloseReason::Dismissed)));
    }
}
