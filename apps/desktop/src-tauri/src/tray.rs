// SPDX-License-Identifier: Apache-2.0
//! The tray icon (docs/DESKTOP.md "Tray"): the voice state of the client (not connected, connected, muted,
//! deafened) as the app icon with a status badge, the tooltip, and a menu with mute, deafen, leave voice, show
//! window and quit. The client's voice store drives it (`tray_set`); the voice items of the menu go back to the
//! client as shell events. The badges are drawn from the app icon at start, so no extra image files exist.
//!
//! "Close to tray" (Settings → App) hides the window instead of quitting. Default: on for Windows (the notification
//! area is always there), off for Linux (GNOME shows no tray icons without an extension; a hidden window could not be
//! brought back there).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::commands::Settings;
use crate::events::{self, ShellEvent, TrayAction};

/// The base of the tray icons (the app icon).
const BASE_ICON: &[u8] = include_bytes!("../icons/32x32.png");
const MAX_LABEL: usize = 64;
const MAX_TOOLTIP: usize = 128;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceState {
    #[default]
    Disconnected,
    Connected,
    Muted,
    Deafened,
}

/// The texts of the tray in the client's language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Labels {
    pub tooltip: String,
    pub mute: String,
    pub deafen: String,
    pub leave: String,
    pub show: String,
    pub quit: String,
}

impl Default for Labels {
    /// Until the client sends its texts.
    fn default() -> Self {
        Self {
            tooltip: "Tavrn".into(),
            mute: "Mute".into(),
            deafen: "Deafen".into(),
            leave: "Leave voice".into(),
            show: "Show Tavrn".into(),
            quit: "Quit".into(),
        }
    }
}

impl Labels {
    pub fn validate(&self) -> Result<(), &'static str> {
        let ok = |s: &str, max: usize| !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control);
        let menu = [&self.mute, &self.deafen, &self.leave, &self.show, &self.quit];
        if ok(&self.tooltip, MAX_TOOLTIP) && menu.iter().all(|l| ok(l, MAX_LABEL)) { Ok(()) } else { Err("tray.invalid") }
    }
}

/// What the tray shows for a state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub badge: Option<Badge>,
    pub mute_checked: bool,
    pub deafen_checked: bool,
    /// Mute, deafen and leave apply only in a call.
    pub voice_items: bool,
}

/// The badge on the app icon: a coloured dot with a symbol (the shape tells the states apart without colour).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Badge {
    /// Green dot.
    Connected,
    /// Amber dot with a bar.
    Muted,
    /// Red dot with a cross.
    Deafened,
}

pub fn view(state: VoiceState) -> View {
    match state {
        VoiceState::Disconnected => View { badge: None, mute_checked: false, deafen_checked: false, voice_items: false },
        VoiceState::Connected => View { badge: Some(Badge::Connected), mute_checked: false, deafen_checked: false, voice_items: true },
        // Deafened implies muted (the client mutes the microphone with the speakers).
        VoiceState::Muted => View { badge: Some(Badge::Muted), mute_checked: true, deafen_checked: false, voice_items: true },
        VoiceState::Deafened => View { badge: Some(Badge::Deafened), mute_checked: true, deafen_checked: true, voice_items: true },
    }
}

impl Badge {
    pub fn color(self) -> [u8; 3] {
        match self {
            Self::Connected => [0x22, 0xc5, 0x5e],
            Self::Muted => [0xf5, 0x9e, 0x0b],
            Self::Deafened => [0xef, 0x44, 0x44],
        }
    }
}

/// The app icon (RGBA, `width` × `height`) with the badge of `state` in the lower right corner.
pub fn badged(rgba: &[u8], width: u32, height: u32, state: VoiceState) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let Some(badge) = view(state).badge else { return out };
    let size = width.min(height) as f32;
    let r = size * 0.24;
    let (cx, cy) = (width as f32 - r - 0.5, height as f32 - r - 0.5);
    let [cr, cg, cb] = badge.color();
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let d = (dx * dx + dy * dy).sqrt();
            let px = match d {
                d if d <= r - 1.5 => {
                    let mark = r * 0.55;
                    let symbol = match badge {
                        Badge::Connected => false,
                        Badge::Muted => dy.abs() <= size * 0.04 + 0.5 && dx.abs() <= mark,
                        Badge::Deafened => (dx - dy).abs() <= size * 0.05 + 0.5 && dx.abs() <= mark || (dx + dy).abs() <= size * 0.05 + 0.5 && dx.abs() <= mark,
                    };
                    if symbol { [255, 255, 255, 255] } else { [cr, cg, cb, 255] }
                }
                // A white ring separates the badge from the icon.
                d if d <= r => [255, 255, 255, 255],
                _ => continue,
            };
            let i = ((y * width + x) * 4) as usize;
            if let Some(p) = out.get_mut(i..i + 4) {
                p.copy_from_slice(&px);
            }
        }
    }
    out
}

/// The icon of `state` for the tray.
pub fn icon(state: VoiceState) -> tauri::Result<Image<'static>> {
    let base = Image::from_bytes(BASE_ICON)?;
    let rgba = badged(base.rgba(), base.width(), base.height(), state);
    Ok(Image::new_owned(rgba, base.width(), base.height()))
}

struct Items<R: Runtime> {
    icon: TrayIcon<R>,
    mute: CheckMenuItem<R>,
    deafen: CheckMenuItem<R>,
    leave: MenuItem<R>,
    show: MenuItem<R>,
    quit: MenuItem<R>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub state: VoiceState,
    pub tooltip: String,
    /// The tray icon exists (false when the desktop offers no tray).
    pub available: bool,
    pub close_to_tray: bool,
}

/// The tray of the app and the state it shows.
pub struct Tray<R: Runtime> {
    items: Option<Items<R>>,
    current: Mutex<(VoiceState, Labels)>,
}

impl<R: Runtime> Tray<R> {
    /// Creates the tray icon; a desktop without a tray yields a tray that only keeps the state.
    pub fn create(app: &AppHandle<R>) -> Self {
        let items = build(app).map_err(|e| eprintln!("tavrn: no tray icon: {e}")).ok();
        Self { items, current: Mutex::new((VoiceState::Disconnected, Labels::default())) }
    }

    pub fn available(&self) -> bool {
        self.items.is_some()
    }

    fn apply(&self, state: VoiceState, labels: &Labels) -> tauri::Result<()> {
        let Some(items) = &self.items else { return Ok(()) };
        let v = view(state);
        items.icon.set_icon(Some(icon(state)?))?;
        items.icon.set_tooltip(Some(&labels.tooltip))?;
        items.mute.set_text(&labels.mute)?;
        items.mute.set_checked(v.mute_checked)?;
        items.mute.set_enabled(v.voice_items)?;
        items.deafen.set_text(&labels.deafen)?;
        items.deafen.set_checked(v.deafen_checked)?;
        items.deafen.set_enabled(v.voice_items)?;
        items.leave.set_text(&labels.leave)?;
        items.leave.set_enabled(v.voice_items)?;
        items.show.set_text(&labels.show)?;
        items.quit.set_text(&labels.quit)?;
        Ok(())
    }

    pub fn set(&self, state: VoiceState, labels: Labels) -> Result<(), String> {
        labels.validate().map_err(str::to_string)?;
        let mut current = self.current.lock().map_err(|_| "tray.unavailable".to_string())?;
        self.apply(state, &labels).map_err(|e| e.to_string())?;
        *current = (state, labels);
        Ok(())
    }

    pub fn state(&self) -> (VoiceState, Labels) {
        self.current.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Items<R>> {
    let labels = Labels::default();
    let mute = CheckMenuItem::with_id(app, "mute", &labels.mute, false, false, None::<&str>)?;
    let deafen = CheckMenuItem::with_id(app, "deafen", &labels.deafen, false, false, None::<&str>)?;
    let leave = MenuItem::with_id(app, "leave", &labels.leave, false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", &labels.show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &labels.quit, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&mute, &deafen, &leave, &separator, &show, &quit])?;
    let icon = TrayIconBuilder::with_id("main")
        .icon(icon(VoiceState::Disconnected)?)
        .tooltip(&labels.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "mute" => events::send(app, ShellEvent::Tray { action: TrayAction::Mute }),
            "deafen" => events::send(app, ShellEvent::Tray { action: TrayAction::Deafen }),
            "leave" => events::send(app, ShellEvent::Tray { action: TrayAction::Leave }),
            "show" => events::show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows: a left click shows the window (Linux trays open the menu instead).
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                events::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(Items { icon, mute, deafen, leave, show, quit })
}

/// "Close to tray" unless the settings say otherwise: on for Windows, off elsewhere (module documentation).
pub fn close_to_tray_default() -> bool {
    cfg!(windows)
}

/// Whether closing the window hides it into the tray (only with a tray icon).
pub fn closes_to_tray<R: Runtime>(app: &AppHandle<R>) -> bool {
    let available = app.try_state::<Tray<R>>().is_some_and(|t| t.available());
    let setting = app.try_state::<Settings>().and_then(|s| s.config.lock().ok().and_then(|c| c.close_to_tray));
    available && setting.unwrap_or_else(close_to_tray_default)
}

/// The client's voice state and the texts of the tray.
#[tauri::command]
pub fn tray_set(tray: State<'_, Tray<tauri::Wry>>, state: VoiceState, labels: Labels) -> Result<(), String> {
    tray.set(state, labels)
}

/// What the tray shows and whether closing hides the window (Settings → App; the smoke test).
#[tauri::command]
pub fn tray_status(app: AppHandle, tray: State<'_, Tray<tauri::Wry>>) -> Status {
    let (state, labels) = tray.state();
    Status { state, tooltip: labels.tooltip, available: tray.available(), close_to_tray: closes_to_tray(&app) }
}

/// Settings → App: close to tray on or off (persisted in the settings file).
#[tauri::command]
pub fn set_close_to_tray(settings: State<'_, Settings>, on: bool) -> Result<(), String> {
    crate::commands::update_config(&settings, |c| c.close_to_tray = Some(on))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded() -> Image<'static> {
        Image::from_bytes(BASE_ICON).map(|i| i.to_owned()).unwrap_or_else(|e| unreachable!("app icon: {e}"))
    }

    fn pixel(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        rgba.get(i..i + 4).and_then(|p| p.try_into().ok()).unwrap_or_default()
    }

    #[test]
    fn states_map_to_badges_and_menu_states() {
        assert_eq!(view(VoiceState::Disconnected), View { badge: None, mute_checked: false, deafen_checked: false, voice_items: false });
        assert_eq!(view(VoiceState::Connected), View { badge: Some(Badge::Connected), mute_checked: false, deafen_checked: false, voice_items: true });
        assert_eq!(view(VoiceState::Muted), View { badge: Some(Badge::Muted), mute_checked: true, deafen_checked: false, voice_items: true });
        assert_eq!(view(VoiceState::Deafened), View { badge: Some(Badge::Deafened), mute_checked: true, deafen_checked: true, voice_items: true });
    }

    #[test]
    fn the_client_sends_states_in_snake_case() -> serde_json::Result<()> {
        assert_eq!(serde_json::from_str::<VoiceState>(r#""deafened""#)?, VoiceState::Deafened);
        assert_eq!(serde_json::to_string(&VoiceState::Disconnected)?, r#""disconnected""#);
        assert!(serde_json::from_str::<VoiceState>(r#""speaking""#).is_err());
        Ok(())
    }

    #[test]
    fn four_distinct_icons_from_the_app_icon() {
        let base = decoded();
        let (w, h) = (base.width(), base.height());
        let icons: Vec<Vec<u8>> =
            [VoiceState::Disconnected, VoiceState::Connected, VoiceState::Muted, VoiceState::Deafened].iter().map(|s| badged(base.rgba(), w, h, *s)).collect();
        assert_eq!(icons[0], base.rgba(), "not connected: the plain app icon");
        for (i, a) in icons.iter().enumerate() {
            assert_eq!(a.len(), (w * h * 4) as usize);
            for b in icons.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
        // The badge sits in the lower right corner; the upper left stays the app icon.
        let r = (w.min(h) as f32 * 0.24) as u32;
        let (cx, cy) = (w - r, h - r);
        let rgb = |p: [u8; 4]| [p[0], p[1], p[2]];
        assert_eq!(rgb(pixel(&icons[1], w, cx, cy)), Badge::Connected.color());
        assert_eq!(pixel(&icons[2], w, cx, cy), [255, 255, 255, 255], "the bar of muted crosses the centre");
        assert_eq!(rgb(pixel(&icons[2], w, cx, cy - (r - 1))), Badge::Muted.color());
        assert_eq!(pixel(&icons[3], w, cx, cy), [255, 255, 255, 255], "the cross of deafened crosses the centre");
        assert_eq!(rgb(pixel(&icons[3], w, cx, cy - (r - 1))), Badge::Deafened.color());
        for icon in &icons {
            assert_eq!(pixel(icon, w, 2, 2), pixel(base.rgba(), w, 2, 2));
        }
        assert!(icon(VoiceState::Muted).is_ok());
    }

    #[test]
    fn labels_are_bounded() {
        assert_eq!(Labels::default().validate(), Ok(()));
        let long = Labels { mute: "m".repeat(MAX_LABEL + 1), ..Labels::default() };
        assert_eq!(long.validate(), Err("tray.invalid"));
        let empty = Labels { quit: " ".into(), ..Labels::default() };
        assert_eq!(empty.validate(), Err("tray.invalid"));
        let control = Labels { tooltip: "Tavrn\u{1b}[31m".into(), ..Labels::default() };
        assert_eq!(control.validate(), Err("tray.invalid"));
        let german = Labels {
            tooltip: "Tavrn · Stummgeschaltet".into(),
            mute: "Stummschalten".into(),
            deafen: "Taub schalten".into(),
            leave: "Sprachkanal verlassen".into(),
            show: "Tavrn anzeigen".into(),
            quit: "Beenden".into(),
        };
        assert_eq!(german.validate(), Ok(()));
    }

    #[test]
    fn close_to_tray_is_on_for_windows_only() {
        assert_eq!(close_to_tray_default(), cfg!(windows));
    }
}
