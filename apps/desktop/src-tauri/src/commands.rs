// SPDX-License-Identifier: Apache-2.0
//! The commands the bundled client may call (capabilities/main.json grants exactly these to the main window;
//! `web/src/platform/tauri.ts` is their only caller).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::UpdaterExt;

use crate::{config, guard, node_url, updater};

/// The settings file and its current content.
pub struct Settings {
    pub path: PathBuf,
    pub config: Mutex<config::Config>,
}

impl Settings {
    pub fn load(path: PathBuf) -> Self {
        let config = Mutex::new(config::load(&path));
        Self { path, config }
    }
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub version: String,
    /// False while the build carries no updater key (the placeholder of tauri.conf.json).
    pub updater: bool,
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
}

/// The settings (the chosen home node).
#[tauri::command]
pub fn get_config(settings: State<'_, Settings>) -> Result<config::Config, String> {
    settings.config.lock().map(|c| c.clone()).map_err(|_| "config.unavailable".to_string())
}

/// Validates and persists the home node; returns its normalized origin.
#[tauri::command]
pub fn set_node(settings: State<'_, Settings>, url: String) -> Result<String, String> {
    set_node_in(&settings, &url)
}

pub fn set_node_in(settings: &Settings, url: &str) -> Result<String, String> {
    let node = node_url::validate(url).map_err(|e| e.code().to_string())?;
    let mut current = settings.config.lock().map_err(|_| "config.unavailable".to_string())?;
    let next = config::Config { node: Some(node.clone()) };
    config::save(&settings.path, &next).map_err(|e| format!("config.write_failed: {e}"))?;
    *current = next;
    Ok(node)
}

#[tauri::command]
pub fn app_info<R: Runtime>(app: AppHandle<R>) -> AppInfo {
    AppInfo { version: app.package_info().version.to_string(), updater: updater::configured(app.config().plugins.0.get("updater")) }
}

/// Opens a web link (http, https, mailto) in the system browser.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let url = guard::external_str(&url).ok_or_else(|| "link.refused".to_string())?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// The newest signed release when it is newer than this app.
#[tauri::command]
pub async fn check_update<R: Runtime>(app: AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    if !updater::configured(app.config().plugins.0.get("updater")) {
        return Err("update.not_configured".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// Downloads the newest release, verifies its signature, installs it and restarts the app.
#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if !updater::configured(app.config().plugins.0.get("updater")) {
        return Err("update.not_configured".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Err("update.none".into()) };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}

/// The settings file of this installation.
pub fn settings_path<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join(config::FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(name: &str) -> Settings {
        let d = std::env::temp_dir().join(format!("tavrn-desktop-cmd-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Settings::load(d.join(config::FILE_NAME))
    }

    #[test]
    fn set_node_validates_normalizes_and_persists() {
        let s = settings("set");
        assert_eq!(set_node_in(&s, "https://Tavrn.Example/"), Ok("https://tavrn.example".into()));
        assert_eq!(config::load(&s.path).node.as_deref(), Some("https://tavrn.example"));
        assert_eq!(s.config.lock().map(|c| c.node.clone()).ok().flatten().as_deref(), Some("https://tavrn.example"));
        let _ = std::fs::remove_dir_all(s.path.parent().unwrap_or(&s.path));
    }

    #[test]
    fn set_node_refuses_invalid_urls_and_keeps_the_old_node() {
        let s = settings("refuse");
        assert!(set_node_in(&s, "https://tavrn.example").is_ok());
        assert_eq!(set_node_in(&s, "http://evil"), Err("node_url.insecure".into()));
        assert_eq!(set_node_in(&s, "https://x.example/path"), Err("node_url.path".into()));
        assert_eq!(config::load(&s.path).node.as_deref(), Some("https://tavrn.example"));
        let _ = std::fs::remove_dir_all(s.path.parent().unwrap_or(&s.path));
    }

    #[test]
    fn open_external_refuses_non_web_links() {
        assert_eq!(open_external("file:///etc/passwd".into()), Err("link.refused".into()));
        assert_eq!(open_external("javascript:alert(1)".into()), Err("link.refused".into()));
    }
}
