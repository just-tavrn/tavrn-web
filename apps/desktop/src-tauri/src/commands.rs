// SPDX-License-Identifier: Apache-2.0
//! The commands the bundled client may call (capabilities/main.json grants exactly these to the main window;
//! `web/src/platform/tauri.ts` is their only caller).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_updater::UpdaterExt;

use crate::{config, guard, node_url, resolve, updater};

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

/// Validates and persists the home node (with the origin of its web client and its identity domain when the client
/// knows them from the node's document); returns its normalized origin.
#[tauri::command]
pub fn set_node(settings: State<'_, Settings>, url: String, web: Option<String>, domain: Option<String>) -> Result<String, String> {
    set_node_with(&settings, &url, web.as_deref(), domain.as_deref())
}

pub fn set_node_in(settings: &Settings, url: &str) -> Result<String, String> {
    set_node_with(settings, url, None, None)
}

pub fn set_node_with(settings: &Settings, url: &str, web: Option<&str>, domain: Option<&str>) -> Result<String, String> {
    let node = node_url::validate(url).map_err(|e| e.code().to_string())?;
    let web = web.map(node_url::validate).transpose().map_err(|e| e.code().to_string())?;
    let domain = domain.map(|d| d.trim().to_ascii_lowercase());
    if domain.as_deref().is_some_and(|d| !config::valid_identity_domain(d)) {
        return Err("node_url.domain".into());
    }
    update_config(settings, |c| {
        c.node = Some(node.clone());
        c.web = web;
        c.domain = domain;
    })?;
    Ok(node)
}

/// Changes the settings and writes them; the settings in memory change only when the file was written.
pub fn update_config(settings: &Settings, change: impl FnOnce(&mut config::Config)) -> Result<(), String> {
    let mut current = settings.config.lock().map_err(|_| "config.unavailable".to_string())?;
    let mut next = current.clone();
    change(&mut next);
    config::save(&settings.path, &next).map_err(|e| format!("config.write_failed: {e}"))?;
    *current = next;
    Ok(())
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

/// Address first: the node of an identity domain (FEDERATION.md §1.4: well-known, SRV, direct), `resolve.rs`.
#[tauri::command]
pub async fn resolve_node<R: Runtime>(app: AppHandle<R>, domain: String) -> Result<resolve::Resolved, resolve::Failure> {
    let fetcher = resolve::HttpFetcher::new(&app.package_info().version.to_string())
        .map_err(|_| resolve::Failure::new(resolve::UNREACHABLE, resolve::Step::WellKnown, &domain))?;
    resolve::resolve(&domain, &fetcher, &resolve::SystemSrv).await
}

/// Opens (or shows again) the sign-in window with the chosen node's `/connect` page of an app session
/// (docs/DESKTOP.md "Signing in"). Async: windows must not be created from a synchronous command (Windows).
#[tauri::command]
pub async fn open_connect<R: Runtime>(app: AppHandle<R>, settings: State<'_, Settings>, url: String) -> Result<(), String> {
    let web = {
        let config = settings.config.lock().map_err(|_| "config.unavailable".to_string())?;
        config.web.clone().or_else(|| config.node.clone())
    };
    let web = web.ok_or_else(|| "connect.no_node".to_string())?;
    let url = guard::connect_url(&url, &web).map_err(|e| format!("connect.url_refused: {e:?}"))?;
    crate::open_connect_window(&app, url).map_err(|e| e.to_string())
}

/// Closes the sign-in window (the app has its session, or the user cancelled).
#[tauri::command]
pub fn close_connect<R: Runtime>(app: AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::CONNECT_WINDOW) {
        let _ = window.close();
    }
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
    fn set_node_keeps_the_web_origin_and_the_identity_domain_of_a_delegated_node() {
        let s = settings("delegated");
        assert_eq!(
            set_node_with(&s, "https://app.tavrn.example", Some("https://Web.Tavrn.Example/"), Some("Tavrn.Example")),
            Ok("https://app.tavrn.example".into())
        );
        let c = config::load(&s.path);
        assert_eq!((c.web.as_deref(), c.domain.as_deref()), (Some("https://web.tavrn.example"), Some("tavrn.example")));
        assert_eq!(set_node_with(&s, "https://x.example", Some("http://evil.example"), None), Err("node_url.insecure".into()));
        assert_eq!(set_node_with(&s, "https://x.example", None, Some("not a domain")), Err("node_url.domain".into()));
        assert_eq!(config::load(&s.path).domain.as_deref(), Some("tavrn.example"), "refusals keep the old settings");
        // The node URL alone (the advanced picker) forgets the old node's details.
        assert!(set_node_in(&s, "https://other.example").is_ok());
        assert_eq!(config::load(&s.path), config::Config { node: Some("https://other.example".into()), web: None, domain: None, close_to_tray: None });
        let _ = std::fs::remove_dir_all(s.path.parent().unwrap_or(&s.path));
    }

    #[test]
    fn changing_one_setting_keeps_the_others() {
        let s = settings("keep");
        assert!(set_node_in(&s, "https://tavrn.example").is_ok());
        assert_eq!(update_config(&s, |c| c.close_to_tray = Some(false)), Ok(()));
        assert!(set_node_in(&s, "https://other.example").is_ok());
        let stored = config::load(&s.path);
        assert_eq!(stored.node.as_deref(), Some("https://other.example"));
        assert_eq!(stored.close_to_tray, Some(false));
        let _ = std::fs::remove_dir_all(s.path.parent().unwrap_or(&s.path));
    }

    #[test]
    fn open_external_refuses_non_web_links() {
        assert_eq!(open_external("file:///etc/passwd".into()), Err("link.refused".into()));
        assert_eq!(open_external("javascript:alert(1)".into()), Err("link.refused".into()));
    }
}
