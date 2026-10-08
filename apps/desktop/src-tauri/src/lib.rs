// SPDX-License-Identifier: Apache-2.0
//! tavrn desktop app: a Tauri shell around the bundled web client (docs/DESKTOP.md). The main window shows only
//! the bundled client (`web/dist`); the client talks to the home node chosen in its node picker over https/wss.
//! The shell offers the client a handful of commands (`commands.rs`): the chosen node, opening links in the system
//! browser, signed updates. Later steps add global hotkeys, the OS keychain, notifications and the tray.

pub mod commands;
pub mod config;
pub mod guard;
pub mod node_url;
pub mod updater;

#[cfg(test)]
mod conf_tests;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewWindowBuilder};

/// Label of the only window; capabilities/main.json applies to it.
pub const MAIN_WINDOW: &str = "main";

pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::set_node,
            commands::app_info,
            commands::open_external,
            commands::check_update,
            commands::install_update,
        ])
        .setup(|app| {
            let handle = app.handle();
            app.manage(commands::Settings::load(commands::settings_path(handle)?));
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
