// SPDX-License-Identifier: Apache-2.0
//! tavrn desktop app: a Tauri shell around the bundled web client (docs/DESKTOP.md). The main window shows only
//! the bundled client (`web/dist`); the client talks to the home node chosen in its node picker over https/wss.
//! The shell offers the client a handful of commands (`commands.rs`): the chosen node, opening links in the system
//! browser, signed updates, the OS keychain (`keychain.rs`), native notifications (`notify.rs`) and the tray
//! (`tray.rs`), whose clicks come back to the client as shell events (`events.rs`).

pub mod commands;
pub mod config;
pub mod events;
pub mod guard;
pub mod keychain;
pub mod node_url;
pub mod notify;
pub mod tray;
pub mod updater;

#[cfg(test)]
mod conf_tests;

use std::sync::Arc;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewWindowBuilder, WindowEvent};

/// Label of the only window; capabilities/main.json applies to it.
pub const MAIN_WINDOW: &str = "main";

pub fn run() {
    let builder = tauri::Builder::default();
    // A second start (launcher, Start menu, a Windows notification click) shows the running app, which may sit in the
    // tray. On Linux the plugin needs the session bus; without one (a bare session, CI under xvfb) it is left out.
    #[cfg(any(windows, target_os = "linux"))]
    let builder =
        if cfg!(windows) || session_bus() { builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| events::show_main(app))) } else { builder };
    let result = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_node,
            commands::app_info,
            commands::open_external,
            commands::check_update,
            commands::install_update,
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
            WebviewWindowBuilder::from_config(handle, &window)?
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
                .build()?;
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
