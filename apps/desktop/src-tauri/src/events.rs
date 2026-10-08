// SPDX-License-Identifier: Apache-2.0
//! Events of the shell for the client: a notification was clicked (open its conversation), a tray menu item was
//! chosen (mute, deafen, leave voice). The client hands the shell one IPC channel (`shell_events`); no event plugin
//! and no extra permission is involved. A reload hands a new channel, which replaces the old one.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayAction {
    Mute,
    Deafen,
    Leave,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellEvent {
    /// A notification was clicked: the client opens this path (validated when the notification was shown).
    Open { path: String },
    /// A voice action of the tray menu.
    Tray { action: TrayAction },
}

/// The client's channel (none before the client subscribed).
#[derive(Default)]
pub struct ShellEvents(Mutex<Option<Channel<ShellEvent>>>);

impl ShellEvents {
    /// Sends `event` to the client; false when nobody listens.
    pub fn send(&self, event: ShellEvent) -> bool {
        let Ok(guard) = self.0.lock() else { return false };
        guard.as_ref().is_some_and(|channel| channel.send(event).is_ok())
    }
}

/// Sends an event to the client of the main window (dropped when it has not subscribed).
pub fn send<R: Runtime>(app: &AppHandle<R>, event: ShellEvent) {
    if let Some(events) = app.try_state::<ShellEvents>() {
        events.send(event);
    }
}

/// Brings the main window to the front (tray "Show", a notification click, a second start of the app).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The client subscribes to the shell's events.
#[tauri::command]
pub fn shell_events(events: State<'_, ShellEvents>, on_event: Channel<ShellEvent>) -> Result<(), String> {
    *events.0.lock().map_err(|_| "events.unavailable".to_string())? = Some(on_event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_as_the_client_expects() -> serde_json::Result<()> {
        assert_eq!(serde_json::to_string(&ShellEvent::Open { path: "/rooms/1/channels/2".into() })?, r#"{"kind":"open","path":"/rooms/1/channels/2"}"#);
        assert_eq!(serde_json::to_string(&ShellEvent::Tray { action: TrayAction::Deafen })?, r#"{"kind":"tray","action":"deafen"}"#);
        Ok(())
    }

    #[test]
    fn without_a_subscriber_events_are_dropped() {
        assert!(!ShellEvents::default().send(ShellEvent::Tray { action: TrayAction::Mute }));
    }
}
