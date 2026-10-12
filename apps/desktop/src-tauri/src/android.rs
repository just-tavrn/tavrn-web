// SPDX-License-Identifier: Apache-2.0
//! The Android app's bridge to its Kotlin side (docs/ANDROID.md). The Kotlin plugin `ShellPlugin`
//! (`gen/android/app/src/main/java/org/tavrn/app/ShellPlugin.kt`) does what only Android can: runtime permissions,
//! the foreground service of voice, UnifiedPush, notifications, the back gesture, app links, the system bars. The
//! webview never reaches it directly: the plugin has no permission in any capability, so only these commands (granted
//! by capabilities/mobile.json) call it, after `mobile.rs` checked their input; its events come back through `mobile.rs`
//! to the client's `shell_events` channel.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime, State, Wry};

use crate::commands::Settings;
use crate::mobile::{self, AudioRoute, AudioRoutes, Insets, OrientationLock, Permission, PushConfig, PushEndpoint, SettingsPage, VoiceNotice};
use crate::{events, guard, notify};

/// Package and class of the Kotlin plugin.
const PLUGIN_PACKAGE: &str = "org.tavrn.app";
const PLUGIN_CLASS: &str = "ShellPlugin";

/// The registered Kotlin plugin.
pub struct Android<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Android<R> {
    /// Opens a checked web link in the browser (`tab`: a Custom Tab, the sign-in).
    pub async fn open_url(&self, url: &str, tab: bool) -> Result<(), String> {
        self.call("openUrl", json!({ "url": url, "tab": tab })).await
    }

    /// A passkey ceremony through the Credential Manager (`Passkeys.kt`): `request` is the options' JSON (without the
    /// `publicKey` wrapper), the answer the credential's JSON as Android returns it.
    pub async fn passkey(&self, create: bool, request: String) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Answer {
            response: String,
        }
        let answer: Answer = self.call(if create { "passkeyCreate" } else { "passkeyGet" }, json!({ "request": request })).await?;
        Ok(answer.response)
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, command: &str, payload: serde_json::Value) -> Result<T, String> {
        self.0.run_mobile_plugin_async(command, payload).await.map_err(|e| match e {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => r.code.unwrap_or_else(|| "android.failed".into()),
            _ => "android.failed".into(),
        })
    }
}

/// Registers the Kotlin plugin and routes its events (checked by `mobile::parse_native`) to the client.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("tavrn-android")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            let events_app = app.clone();
            let sink = Channel::<serde_json::Value>::new(move |body| {
                if let InvokeResponseBody::Json(json) = body
                    && let Some(event) = mobile::parse_native(&json)
                {
                    events::send(&events_app, event);
                }
                Ok(())
            });
            let listener = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = listener.run_mobile_plugin_async::<()>("listen", json!({ "sink": sink })).await {
                    eprintln!("tavrn: no events from the Android side: {e}");
                }
            });
            app.manage(Android(handle));
            Ok(())
        })
        .build()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidInfo {
    /// The Android API level.
    pub sdk: u32,
    /// The webview runs WebAuthn for the app (Android 14+ with a webview that supports it; docs/ANDROID.md "Passkeys").
    pub webauthn: bool,
    /// Passkeys run through Android's Credential Manager (Android 14+, `Passkeys.kt`).
    #[serde(default)]
    pub passkeys: bool,
    /// The app's WebAuthn origin (`android:apk-key-hash:<base64url>` of its signing certificate, checked by
    /// `mobile::app_origin`): the client offers in-app passkeys only while the node lists it in `webauthn.origins`.
    #[serde(default)]
    pub origin: Option<String>,
    /// Installed UnifiedPush distributors (package names).
    pub distributors: Vec<String>,
    /// The distributor this app uses, once one was chosen.
    pub distributor: Option<String>,
    /// The notification permission: `granted`, `denied` or `prompt`.
    pub notifications: String,
    /// The app is exempt from battery optimisations.
    pub battery_exempt: bool,
    /// The "keep a connection for notifications" service runs.
    pub keep_connection: bool,
    pub insets: Insets,
}

#[tauri::command]
pub async fn android_info(android: State<'_, Android<Wry>>) -> Result<AndroidInfo, String> {
    let info: AndroidInfo = android.call("info", json!({})).await?;
    Ok(AndroidInfo { origin: info.origin.as_deref().and_then(mobile::app_origin), ..info })
}

/// Asks for a runtime permission right before its first use: `granted`, `denied` (ask again later) or `blocked` (only
/// the system settings can grant it now).
#[tauri::command]
pub async fn android_permission(android: State<'_, Android<Wry>>, permission: Permission) -> Result<String, String> {
    android.call("permission", json!({ "permission": permission })).await
}

#[tauri::command]
pub async fn android_open_settings(android: State<'_, Android<Wry>>, page: SettingsPage) -> Result<(), String> {
    android.call("openSettings", json!({ "page": page })).await
}

/// The system dialog that exempts the app from battery optimisations (offered with an explanation, never asked by itself).
#[tauri::command]
pub async fn android_battery_exemption(android: State<'_, Android<Wry>>) -> Result<bool, String> {
    android.call("batteryExemption", json!({})).await
}

/// Starts, updates or (state `disconnected`) stops the voice service with its notification.
#[tauri::command]
pub async fn android_voice(android: State<'_, Android<Wry>>, notice: VoiceNotice) -> Result<(), String> {
    notice.validate().map_err(str::to_string)?;
    let shown = VoiceNotice { state: notice.shown_state(), ..notice };
    android.call("voice", serde_json::to_value(shown).map_err(|e| e.to_string())?).await
}

/// The call's audio routes (docs/ANDROID.md "Audio output"): what is connected and what plays.
#[tauri::command]
pub async fn android_audio_routes(android: State<'_, Android<Wry>>) -> Result<AudioRoutes, String> {
    let routes: AudioRoutes = android.call("audioRoutes", json!({})).await?;
    if routes.valid() { Ok(routes) } else { Err("android.failed".into()) }
}

/// Moves the call's audio to `route` (it stays there while the device is connected); the routes afterwards.
#[tauri::command]
pub async fn android_audio_route(android: State<'_, Android<Wry>>, route: AudioRoute) -> Result<AudioRoutes, String> {
    let routes: AudioRoutes = android.call("audioRoute", json!({ "route": route })).await?;
    if routes.valid() { Ok(routes) } else { Err("android.failed".into()) }
}

/// `screen.orientation.lock()` for the page, which Android's webview does not implement (docs/ANDROID.md
/// "Fullscreen"): the Kotlin side allows it only while an element is in fullscreen; `None` releases it.
#[tauri::command]
pub async fn android_orientation(android: State<'_, Android<Wry>>, lock: Option<OrientationLock>) -> Result<(), String> {
    android.call("orientation", json!({ "lock": lock })).await
}

/// The back gesture on the client's first page: the app goes to the background instead of closing.
#[tauri::command]
pub async fn android_background(android: State<'_, Android<Wry>>) -> Result<(), String> {
    android.call("background", json!({})).await
}

/// Registers at the UnifiedPush distributor with the node's VAPID key; the endpoint and its keys for the node.
#[tauri::command]
pub async fn android_push_register(android: State<'_, Android<Wry>>, vapid: String, distributor: Option<String>) -> Result<PushEndpoint, String> {
    let vapid = mobile::vapid_key(&vapid).ok_or("android.invalid")?;
    if distributor.as_deref().is_some_and(|d| d.len() > 200 || !d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')) {
        return Err("android.invalid".into());
    }
    let endpoint: PushEndpoint = android.call("pushRegister", json!({ "vapid": vapid, "distributor": distributor })).await?;
    if endpoint.valid() { Ok(endpoint) } else { Err("push.invalid_endpoint".into()) }
}

#[tauri::command]
pub async fn android_push_unregister(android: State<'_, Android<Wry>>) -> Result<(), String> {
    android.call("pushUnregister", json!({})).await
}

/// The texts the native receiver shows and the account's home node (as the service worker's `tavrn.push.config`).
#[tauri::command]
pub async fn android_push_config(android: State<'_, Android<Wry>>, config: PushConfig) -> Result<(), String> {
    config.validate().map_err(str::to_string)?;
    android.call("pushConfig", json!({ "strings": config.strings, "homeNode": config.home_node })).await
}

/// Without a distributor: a foreground service keeps the app (and the client's WebSocket) running for notifications.
#[tauri::command]
pub async fn android_keep_connection(android: State<'_, Android<Wry>>, on: bool, title: String, text: String) -> Result<(), String> {
    let ok = |s: &str| !s.trim().is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control);
    if on && !(ok(&title) && ok(&text)) {
        return Err("android.invalid".into());
    }
    android.call("keepConnection", json!({ "on": on, "title": title, "text": text })).await
}

/// A notification of the client while the app is in the background (the desktop's `notify`).
#[tauri::command]
pub async fn notify(android: State<'_, Android<Wry>>, notice: notify::Notice) -> Result<(), String> {
    notify::validate(&notice).map_err(str::to_string)?;
    android.call("notify", json!({ "title": notice.title, "body": notice.body, "path": notice.path })).await
}

/// The answer of `android_save_begin`: the picker's document, or the user closed it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SaveBegin {
    Ready { id: String },
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Saved {
    /// The saved document's name as the provider shows it.
    pub name: String,
}

/// Downloads (docs/ANDROID.md "Downloads"): Android's document picker ("Save to"), as the desktop's save dialog; the
/// Kotlin side writes the content to the document the user picked, the webview never names a place.
#[tauri::command]
pub async fn android_save_begin(android: State<'_, Android<Wry>>, name: String, mime: String, size: u64) -> Result<SaveBegin, String> {
    let begin: SaveBegin = android.call("saveBegin", json!({ "name": mobile::save_name(&name), "mime": mobile::save_mime(&mime), "size": size })).await?;
    if let SaveBegin::Ready { id } = &begin
        && !mobile::save_id(id)
    {
        return Err("download.failed".into());
    }
    Ok(begin)
}

/// Appends a piece of the file (base64, at most 1 MiB of content: Android's IPC carries JSON, no raw bodies).
#[tauri::command]
pub async fn android_save_chunk(android: State<'_, Android<Wry>>, id: String, data: String) -> Result<(), String> {
    if !mobile::save_id(&id) || !mobile::save_chunk(&data) {
        return Err("download.invalid".into());
    }
    android.call("saveChunk", json!({ "id": id, "data": data })).await
}

#[tauri::command]
pub async fn android_save_end(android: State<'_, Android<Wry>>, id: String) -> Result<Saved, String> {
    if !mobile::save_id(&id) {
        return Err("download.invalid".into());
    }
    android.call("saveEnd", json!({ "id": id })).await
}

#[tauri::command]
pub async fn android_save_abort(android: State<'_, Android<Wry>>, id: String) -> Result<(), String> {
    if !mobile::save_id(&id) {
        return Err("download.invalid".into());
    }
    android.call("saveAbort", json!({ "id": id })).await
}

/// A newer release with an APK in the chosen update channel (`release.rs`), or none.
#[tauri::command]
pub async fn android_check_update(app: tauri::AppHandle, settings: State<'_, Settings>) -> Result<Option<crate::release::AvailableRelease>, String> {
    let version = app.package_info().version.to_string();
    let channel = crate::commands::update_channel_in(&settings, &version);
    crate::release::fetch(&version, channel).await
}

/// Opens a web link (http, https, mailto) in the browser.
#[tauri::command]
pub async fn open_external(android: State<'_, Android<Wry>>, url: String) -> Result<(), String> {
    let url = guard::external_str(&url).ok_or_else(|| "link.refused".to_string())?;
    android.open_url(&url, false).await
}

/// The chosen node's `/connect` page of an app session in a Custom Tab of the browser (the app has no second window;
/// docs/ANDROID.md "Signing in"). The same checks as the desktop's sign-in window.
#[tauri::command]
pub async fn open_connect(android: State<'_, Android<Wry>>, settings: State<'_, Settings>, url: String) -> Result<(), String> {
    let web = {
        let config = settings.config.lock().map_err(|_| "config.unavailable".to_string())?;
        config.web.clone().or_else(|| config.node.clone())
    };
    let web = web.ok_or_else(|| "connect.no_node".to_string())?;
    let url = guard::connect_url(&url, &web).map_err(|e| format!("connect.url_refused: {e:?}"))?;
    android.open_url(url.as_str(), true).await
}

/// The app has its session (or the user cancelled): back to the app from the browser.
#[tauri::command]
pub async fn close_connect(android: State<'_, Android<Wry>>) -> Result<(), String> {
    android.call("toFront", json!({})).await
}
