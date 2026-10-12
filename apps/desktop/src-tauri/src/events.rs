// SPDX-License-Identifier: Apache-2.0
//! Events of the shell for the client: a notification was clicked (open its conversation), a tray menu item was
//! chosen (mute, deafen, leave voice); in the Android app also the back gesture, app links, the system bars and the
//! keyboard, and new push endpoints (`mobile.rs` checks them). The client hands the shell one IPC channel
//! (`shell_events`); no event plugin and no extra permission is involved. A reload hands a new channel, which replaces
//! the old one.

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellEvent {
    /// A notification was clicked: the client opens this path (validated when the notification was shown).
    Open { path: String },
    /// A voice action of the tray menu (Android: a button of the voice notification).
    Tray { action: TrayAction },
    /// Android: the back gesture; the client goes back, or sends the app to the background from its first page.
    Back,
    /// A deep link opened the app: a `tavrn://` link (`deeplink.rs`; desktop and Android) or an App Link (Android,
    /// `mobile::app_link`). The client shows its target and acts only when the user confirms.
    Link { url: String },
    /// Android: the system bars and the keyboard changed.
    Insets(crate::mobile::Insets),
    /// Android: the push distributor handed a new endpoint; the client registers it at the node.
    PushEndpoint(crate::mobile::PushEndpoint),
    /// Android: the push distributor dropped the registration.
    PushUnregistered,
    /// Android: the call's audio routes changed (`mobile::AudioRoutes`).
    AudioRoutes(crate::mobile::AudioRoutes),
}

/// Links and notification clicks kept while the client has not subscribed yet (the one that started the app).
const MAX_PENDING: usize = 8;

/// The client's channel (none before the client subscribed).
#[derive(Default)]
pub struct ShellEvents(Mutex<Subscriber>);

#[derive(Default)]
struct Subscriber {
    channel: Option<Channel<ShellEvent>>,
    /// Links and notification clicks that arrived before the client subscribed.
    pending: Vec<ShellEvent>,
}

impl ShellEvents {
    /// Sends `event` to the client; false when nobody listens (a link or a notification click then waits for the
    /// client's subscription, every other event is dropped).
    pub fn send(&self, event: ShellEvent) -> bool {
        let Ok(mut guard) = self.0.lock() else { return false };
        if let Some(channel) = guard.channel.as_ref() {
            return channel.send(event).is_ok();
        }
        if matches!(event, ShellEvent::Link { .. } | ShellEvent::Open { .. }) && guard.pending.len() < MAX_PENDING {
            guard.pending.push(event);
        }
        false
    }

    /// The client's (new) channel; hands it what waited.
    pub fn subscribe(&self, channel: Channel<ShellEvent>) -> Result<(), String> {
        let mut guard = self.0.lock().map_err(|_| "events.unavailable".to_string())?;
        for event in std::mem::take(&mut guard.pending) {
            let _ = channel.send(event);
        }
        guard.channel = Some(channel);
        Ok(())
    }

    #[cfg(test)]
    fn pending(&self) -> usize {
        self.0.lock().map(|g| g.pending.len()).unwrap_or_default()
    }
}

/// Sends an event to the client of the main window (dropped when it has not subscribed).
pub fn send<R: Runtime>(app: &AppHandle<R>, event: ShellEvent) {
    if let Some(events) = app.try_state::<ShellEvents>() {
        events.send(event);
    }
}

/// A `tavrn://` link the system handed the desktop app (a start with the link, or a second start that the single
/// instance forwards): checked (`deeplink.rs`), handed to the client (it waits for the client's subscription), and the
/// main window comes to the front. Anything else is dropped.
#[cfg(desktop)]
pub fn open_deep_link<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let Some(url) = crate::deeplink::deep_link(url) else { return };
    send(app, ShellEvent::Link { url });
    show_main(app);
}

/// Brings the main window to the front (tray "Show", a notification click, a second start of the app).
#[cfg(desktop)]
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    crate::tray::window_changed(app);
}

/// The client subscribes to the shell's events.
#[tauri::command]
pub fn shell_events(events: State<'_, ShellEvents>, on_event: Channel<ShellEvent>) -> Result<(), String> {
    events.subscribe(on_event)
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
    fn without_a_subscriber_events_are_dropped_but_links_and_clicks_wait() {
        let events = ShellEvents::default();
        assert!(!events.send(ShellEvent::Tray { action: TrayAction::Mute }));
        assert!(!events.send(ShellEvent::Back));
        assert_eq!(events.pending(), 0);
        for _ in 0..20 {
            assert!(!events.send(ShellEvent::Link { url: "https://app.tavrn.org/invite/code1234".into() }));
        }
        assert!(!events.send(ShellEvent::Open { path: "/".into() }));
        assert_eq!(events.pending(), MAX_PENDING);
        let received = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&received);
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().map_err(|_| tauri::Error::InvokeKey)?.push(json);
            }
            Ok(())
        });
        assert!(events.subscribe(channel).is_ok());
        assert_eq!(events.pending(), 0);
        assert_eq!(received.lock().map(|r| r.len()).unwrap_or_default(), MAX_PENDING);
        assert!(events.send(ShellEvent::Back));
    }
}
