// SPDX-License-Identifier: Apache-2.0
//! tavrn desktop app: a Tauri shell around the bundled web client (docs/DESKTOP.md). The main window shows only
//! the bundled client (`web/dist`); the client talks to the home node chosen in its node picker over https/wss.
//! The shell offers the client a handful of commands (`commands.rs`): the chosen node, opening links in the system
//! browser, signed updates, the OS keychain (`keychain.rs`), native notifications (`notify.rs`) and the tray
//! (`tray.rs`), whose clicks come back to the client as shell events (`events.rs`), and the native voice engine
//! (`voice`, Linux always, Windows behind a setting).

pub mod commands;
pub mod config;
pub mod events;
pub mod guard;
pub mod hotkeys;
pub mod keychain;
pub mod keywatch;
pub mod media;
pub mod node_url;
pub mod notify;
pub mod resolve;
pub mod tray;
pub mod updater;
pub mod voice;

#[cfg(test)]
mod conf_tests;

use std::sync::Arc;

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Label of the app's window; capabilities/main.json applies to it (and only to it).
pub const MAIN_WINDOW: &str = "main";
/// Label of the sign-in window: the node's own `/connect` page, without any capability (docs/DESKTOP.md "Signing in").
pub const CONNECT_WINDOW: &str = "connect";

fn open_link(link: String) {
    let _ = tauri_plugin_opener::open_url(link, None::<&str>);
}

/// Shows `url` (validated by `guard::connect_url`) in the sign-in window, creating it on first use.
pub fn open_connect_window<R: Runtime>(app: &AppHandle<R>, url: Url) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(CONNECT_WINDOW) {
        window.navigate(url)?;
        window.show()?;
        return window.set_focus();
    }
    let dev_url: Option<Url> = if cfg!(dev) { app.config().build.dev_url.clone() } else { None };
    WebviewWindowBuilder::new(app, CONNECT_WINDOW, WebviewUrl::External(url))
        .title("Tavrn")
        .inner_size(520.0, 760.0)
        .min_inner_size(360.0, 480.0)
        .on_navigation(move |url| match guard::connect_navigation(url, dev_url.as_ref()) {
            guard::Navigation::Allow => true,
            guard::Navigation::External(link) => {
                open_link(link);
                false
            }
            guard::Navigation::Deny => false,
        })
        .on_new_window(|url, _features| {
            if let Some(link) = guard::new_window(&url) {
                open_link(link);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default();
    // A second start (launcher, Start menu, a Windows notification click) shows the running app, which may sit in the
    // tray. On Linux the plugin needs the session bus; without one (a bare session, CI under xvfb) it is left out.
    #[cfg(any(windows, target_os = "linux"))]
    let builder =
        if cfg!(windows) || session_bus() { builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| events::show_main(app))) } else { builder };
    // Push-to-talk of the native voice engine follows the system-wide hotkey directly (also while the webview is in the
    // background); the client hears the same events and tells the engine too.
    let voice = voice::VoiceShell::default();
    let hotkeys = hotkeys::Hotkeys::default();
    let control = Arc::clone(&voice.control);
    hotkeys.set_tap(move |e| {
        if e.action == hotkeys::Action::PushToTalk {
            control.set_ptt(e.pressed);
        }
    });
    let result = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(hotkeys)
        .manage(voice)
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_node,
            commands::app_info,
            commands::open_external,
            commands::check_update,
            commands::install_update,
            commands::resolve_node,
            commands::open_connect,
            commands::close_connect,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
            keychain::keychain_status,
            notify::notify,
            events::shell_events,
            tray::tray_set,
            tray::tray_status,
            tray::set_close_to_tray,
            tray::quit_app,
            hotkeys::register_hotkey,
            hotkeys::unregister_hotkey,
            hotkeys::listen_hotkeys,
            hotkeys::set_hotkeys_enabled,
            voice::voice_info,
            voice::voice_devices,
            voice::voice_join,
            voice::voice_leave,
            voice::voice_set_key,
            voice::voice_set_muted,
            voice::voice_set_deafened,
            voice::voice_set_ptt,
            voice::voice_configure,
            voice::voice_set_volumes,
        ])
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            match event {
                // Close to tray (Settings → App): hide instead of quitting.
                WindowEvent::CloseRequested { api, .. } if tray::closes_to_tray(window.app_handle()) => {
                    api.prevent_close();
                    tray::hide_main(window.app_handle());
                }
                WindowEvent::Focused(_) | WindowEvent::Resized(_) => tray::window_changed(window.app_handle()),
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle();
            app.manage(commands::Settings::load(commands::settings_path(handle)?));
            app.manage(Arc::new(keychain::Keychain::from_env()));
            app.manage(events::ShellEvents::default());
            app.manage(tray::Tray::create(handle));
            let window = app.config().app.windows.iter().find(|w| w.label == MAIN_WINDOW).cloned().ok_or("tauri.conf.json defines no main window")?;
            let dev_url: Option<Url> = if cfg!(dev) { app.config().build.dev_url.clone() } else { None };
            let nav_dev_url = dev_url.clone();
            #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
            let main = WebviewWindowBuilder::from_config(handle, &window)?
                .on_navigation(move |url| match guard::navigation(url, nav_dev_url.as_ref()) {
                    guard::Navigation::Allow => true,
                    guard::Navigation::External(link) => {
                        let _ = tauri_plugin_opener::open_url(link, None::<&str>);
                        false
                    }
                    guard::Navigation::Deny => false,
                })
                .on_new_window(|url, _features| {
                    if let Some(link) = guard::new_window(&url) {
                        let _ = tauri_plugin_opener::open_url(link, None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .on_permission_request(|_, kind| media::permission(kind))
                .build()?;
            #[cfg(target_os = "linux")]
            media::enable_webrtc(&main)?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("tavrn: the app could not start: {e}");
        std::process::exit(1);
    }
}

/// A D-Bus session bus can be reached (its address in the environment, or the standard socket of the user session).
#[cfg(target_os = "linux")]
fn session_bus() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|a| !a.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|d| std::path::Path::new(&d).join("bus").exists())
}

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
fn session_bus() -> bool {
    false
}
